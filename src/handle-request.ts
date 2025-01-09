import { NextRequest } from "next/server";

/**
 * 从原请求头中挑选指定 key 的头部，返回一个新的 Headers 对象
 */
const pickHeaders = (headers: Headers, allowList: (string | RegExp)[]): Headers => {
  const picked = new Headers();
  // 使用 forEach 来迭代，避免 TS 对 headers.keys() 报错
  headers.forEach((value, key) => {
    // 如果命中 allowList，就放行
    if (allowList.some((k) => (typeof k === "string" ? k === key : k.test(key)))) {
      picked.set(key, value);
    }
  });
  return picked;
};

/**
 * 通用的 CORS 头，允许跨域
 */
const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "*",
  "access-control-allow-headers": "*",
};

/**
 * 通过环境变量控制是否需要修改 safety_settings
 * 如果部署在 Vercel，可以在项目设置里添加环境变量：MODIFY_SAFETY_SETTINGS = True / False
 */
const MODIFY_SAFETY_SETTINGS = process.env.MODIFY_SAFETY_SETTINGS === "True";

export default async function handleRequest(request: NextRequest & { nextUrl?: URL }) {
  // 1. 处理 OPTIONS 请求（CORS 预检）
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: CORS_HEADERS,
    });
  }

  // 2. 如果访问根路径 `/`，返回一个简单的 HTML 页面
  const { pathname, searchParams } = request.nextUrl ?? new URL(request.url);
  if (pathname === "/") {
    const blank_html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Google PaLM API proxy on Vercel Edge</title>
</head>
<body>
  <h1>Google PaLM API proxy on Vercel Edge</h1>
  <p>This proxy helps bypass certain location restrictions and adds custom logic to PaLM API requests.</p>
  <p>For more info, visit <a href="https://simonmy.com/posts/使用vercel反向代理google-palm-api.html">this blog post</a>.</p>
</body>
</html>
    `;
    return new Response(blank_html, {
      headers: {
        ...CORS_HEADERS,
        "content-type": "text/html",
      },
    });
  }

  // 3. 构造要转发到的 Google PaLM API URL
  const url = new URL(pathname, "https://generativelanguage.googleapis.com");
  // 如果在 rewrites 中携带了 _path，就移除它（防止重复）
  searchParams.delete("_path");
  searchParams.forEach((value, key) => {
    url.searchParams.append(key, value);
  });

  // 4. 处理请求体：POST 且需要修改时，解析并修改 safety_settings.threshold
  let newRequestBody: BodyInit | null = request.body;
  let rawBodyText = ""; // 提前声明，catch 中也能访问

  if (request.method === "POST" && MODIFY_SAFETY_SETTINGS) {
    try {
      // Edge Function 中 request.body 是个 ReadableStream，需先取文本
      rawBodyText = await request.text();
      const parsedJson = JSON.parse(rawBodyText);

      if (Array.isArray(parsedJson?.safety_settings)) {
        for (const setting of parsedJson.safety_settings) {
          if (
            setting &&
            typeof setting === "object" &&
            "threshold" in setting
          ) {
            // 修改为 "OFF"
            setting.threshold = "OFF";
          }
        }
      }

      // 再把修改后的对象 stringify 回请求体
      newRequestBody = JSON.stringify(parsedJson);
    } catch (error) {
      console.error("Failed to parse/modify request body:", error);
      // 如果解析失败，直接用原始文本回退
      newRequestBody = rawBodyText;
    }
  }

  // 5. 挑选要传给下游的请求头
  const headers = pickHeaders(request.headers, [
    "content-type",
    "x-goog-api-client",
    "x-goog-api-key",
  ]);

  // 6. 发送请求给 Google PaLM API
  const response = await fetch(url, {
    method: request.method,
    headers,
    body: newRequestBody,
  });

  // 7. 合并下游 response 的 headers 与 CORS 头
  const responseHeaders = {
    ...CORS_HEADERS,
    ...Object.fromEntries(response.headers),
  };

  // 8. 返回代理后的响应
  return new Response(response.body, {
    headers: responseHeaders,
    status: response.status,
  });
}
