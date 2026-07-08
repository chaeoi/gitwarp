import { withCors } from "./http.js";

export function registryPingResponse(request, requestUrl) {
  if (!request.headers.has("Authorization")) {
    return withCors(
      new Response(JSON.stringify({ errors: [{ code: "UNAUTHORIZED", message: "authentication required" }] }), {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "Docker-Distribution-Api-Version": "registry/2.0",
          "WWW-Authenticate": `Bearer realm="${requestUrl.origin}/token",service="${requestUrl.hostname}"`,
          "X-Registry-Name": "GitWarp",
          "X-Registry-Upstream": "multi",
          "X-Registry-Cache": "BYPASS",
        },
      }),
    );
  }

  return withCors(
    new Response(request.method === "HEAD" ? null : "{}", {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Docker-Distribution-Api-Version": "registry/2.0",
        "X-Registry-Name": "GitWarp",
        "X-Registry-Upstream": "multi",
        "X-Registry-Cache": "BYPASS",
      },
    }),
  );
}
