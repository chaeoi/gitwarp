import { BROKER_TOKEN, HOP_BY_HOP_HEADERS } from "./constants.js";

export function buildUpstreamHeaders(headers) {
  const nextHeaders = new Headers();
  for (const [key, value] of headers.entries()) {
    const lowerKey = key.toLowerCase();
    if (lowerKey === "authorization" && isBrokerAuthorization(value)) {
      continue;
    }
    if (!HOP_BY_HOP_HEADERS.has(lowerKey) && !lowerKey.startsWith("cf-")) {
      nextHeaders.set(key, value);
    }
  }
  return nextHeaders;
}

export function withCors(response) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Authorization, Accept, Content-Type, Range");
  headers.set(
    "Access-Control-Expose-Headers",
    "Docker-Content-Digest, Docker-Distribution-Api-Version, Location, WWW-Authenticate, X-Registry-Cache, X-Registry-Name, X-Registry-Upstream",
  );

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function json(body, status = 200, headers = {}) {
  return withCors(
    new Response(JSON.stringify(body, null, 2), {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        ...headers,
      },
    }),
  );
}

export function acceptsHtml(request) {
  return request.headers.get("Accept")?.includes("text/html");
}

function isBrokerAuthorization(value) {
  return value.trim().toLowerCase() === `bearer ${BROKER_TOKEN}`;
}
