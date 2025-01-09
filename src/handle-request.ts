import { NextRequest } from "next/server";

/**
 * 仅挑选关键信息的请求头
 */
const pickHeaders = (headers: Headers, keys: (string | RegExp)[]): Headers => {
  const picked = new Headers();
  for (const key of headers.keys()) {
    if (keys.some((k) => (typeof k === "string" ? k === key : k.test(key)))) {
      const value = headers.get(key);
      if (typeof value === "string") {
        picked.set(key, value);
      }
    }
  }
  return picked;
};

/**
 * 通用 CORS 头
 */
const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "*",
  "access-control-allow-headers": "*",
};

/**
 * 读取环境变量，判断是否要修改 safety_settings
 */
const MODIFY_SAFETY_SETTINGS = process.env.MODIFY_SAFETY_SETTINGS === "True";

export default async function handleRequest(request: NextRequest & { nextUrl?: URL }) {
  // 1. 处理 OPTIONS 预检请求
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: CORS_HEADERS,
    });
  }

  // 2. 如果访问根路径 `/`，返回介绍页面
  const { pathname, searchParams } = request.nextUrl ? request.nextUrl : new URL(request.url);
  if (pathname === "/") {
    const blank_html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Google PaLM API proxy on Vercel Edge</title>
</head>
<body>
  <h1 id="google-palm-api-proxy-on-vercel-edge">Google PaLM API proxy on Vercel Edge</h1>
  <p>Tips: This project uses a reverse proxy to solve problems such as location restrictions in Google APIs. </p>
  <p>If you have any of the following requirements, you may need the support of this project.</p>
  <ol>
    <li>When you see the error message "User location is not supported for the API use" when calling the Google PaLM API</li>
    <li>You want to customize the Google PaLM API</li>
  </ol>
  <p>For technical discussions, please visit <a href="https://simonmy.com/posts/使用vercel反向代理google-palm-api.html">https://simonmy.com/posts/使用vercel反向代理google-palm-api.html</a></p>
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
  searchParams.delete("_path"); // 在 rewrite 中可能带了 _path, 这里清除掉

  // 将其余 query 参数拼到目标 url
  searchParams.forEach((value, key) => {
    url.searchParams.append(key, value);
  });

  // 4. 处理请求体 -- 如果是 POST 且环境变量为 True，就改掉 safety_settings 的 threshold
  let newRequestBody: BodyInit | null = request.body;
  if (request.method === "POST" && MODIFY_SAFETY_SETTINGS) {
    try {
      // 注意：Edge Function 中 request.body 可能是 ReadableStream，要先 read 出来
      const rawBodyText = await request.text(); // 取出文本形式
      const parsedJson = JSON.parse(rawBodyText);

      if (Array.isArray(parsedJson?.safety_settings)) {
        for (const setting of parsedJson.safety_settings) {
          // 只要有 threshold，就改为 "OFF"
          if (setting && typeof setting === "object" && "threshold" in setting) {
            setting.threshold = "OFF";
          }
        }
      }

      // 再把解析/修改后的对象 stringify 回去
      newRequestBody = JSON.stringify(parsedJson);
    } catch (error) {
      // 如果解析失败，也不阻塞请求。可加日志或其他处理
      console.error("Failed to parse/modify request body:", error);
      // newRequestBody = 原样保留
      newRequestBody = rawBodyText;
    }
  }

  // 5. 挑选并传递给下游的请求头
  const headers = pickHeaders(request.headers, [
    "content-type",
    "x-goog-api-client",
    "x-goog-api-key",
  ]);

  // 6. 发起 fetch 到 Google PaLM API
  const response = await fetch(url, {
    method: request.method,
    headers,
    body: newRequestBody,
  });

  // 7. 组合下游 response 的 headers + CORS 头
  const responseHeaders = {
    ...CORS_HEADERS,
    ...Object.fromEntries(response.headers),
  };

  // 8. 返回响应
  return new Response(response.body, {
    headers: responseHeaders,
    status: response.status,
  });
}
