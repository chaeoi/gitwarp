const REGISTRIES = {
  dockerhub: {
    upstream: "registry-1.docker.io",
    tokenHost: "auth.docker.io",
    authService: "registry.docker.io",
    hostHints: ["dhub", "dockerhub", "docker-hub", "docker"],
  },
  ghcr: {
    upstream: "ghcr.io",
    tokenHost: "ghcr.io",
    authService: "ghcr.io",
    hostHints: ["ghcr", "github-container-registry"],
  },
};

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
]);

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export async function onRequest(context) {
  const { request, env, waitUntil } = context;
  const requestUrl = new URL(request.url);

  if (request.method === "OPTIONS") {
    return withCors(new Response(null, { status: 204 }));
  }

  if (!READ_METHODS.has(request.method)) {
    return json(
      {
        error: "method_not_allowed",
        message: "This registry proxy is pull-only. Push, delete, and upload methods are disabled.",
      },
      405,
      { Allow: "GET, HEAD, OPTIONS" },
    );
  }

  if (requestUrl.pathname === "/" && acceptsHtml(request)) {
    return env.ASSETS.fetch(request);
  }

  const registry = selectRegistry(requestUrl.hostname, env);
  if (!registry) {
    return json(
      {
        error: "registry_not_selected",
        message:
          "Set REGISTRY=dockerhub or REGISTRY=ghcr, or deploy this project with dockerhub/ghcr in the hostname.",
      },
      500,
    );
  }

  const upstreamUrl = buildUpstreamUrl(requestUrl, registry);
  const upstreamRequest = new Request(upstreamUrl, {
    method: request.method,
    headers: buildUpstreamHeaders(request.headers),
    redirect: "follow",
  });

  if (!shouldUseCache(request, upstreamUrl, env)) {
    return withCors(await fetchAndNormalize(upstreamRequest, requestUrl, registry, env));
  }

  const cache = caches.default;
  const cacheRequest = buildCacheRequest(request, upstreamUrl, registry);

  if (request.method === "GET") {
    const cached = await cache.match(cacheRequest);
    if (cached) {
      return withCors(addProxyHeaders(cached, registry, "HIT"));
    }
  }

  const upstreamResponse = await fetchAndNormalize(upstreamRequest, requestUrl, registry, env);
  const response = addProxyHeaders(upstreamResponse, registry, "MISS", upstreamUrl);

  if (request.method === "GET" && isCacheableResponse(response)) {
    waitUntil(cache.put(cacheRequest, response.clone()));
  }

  return withCors(response);
}

function selectRegistry(hostname, env) {
  const explicit = String(env.REGISTRY || env.UPSTREAM_REGISTRY || "").trim().toLowerCase();
  if (explicit) {
    if (REGISTRIES[explicit]) return REGISTRIES[explicit];
    const match = Object.values(REGISTRIES).find((registry) => registry.upstream === explicit);
    if (match) return match;
  }

  const host = hostname.toLowerCase();
  return Object.values(REGISTRIES).find((registry) =>
    registry.hostHints.some((hint) => host.includes(hint)),
  );
}

function buildUpstreamUrl(requestUrl, registry) {
  const upstreamUrl = new URL(requestUrl.toString());
  const upstreamHost = selectUpstreamHost(requestUrl.pathname, registry);

  upstreamUrl.protocol = "https:";
  upstreamUrl.hostname = upstreamHost;
  upstreamUrl.port = "";
  if (upstreamHost === registry.upstream) {
    upstreamUrl.pathname = rewriteDockerHubOfficialImagePath(requestUrl.pathname, registry);
  }
  return upstreamUrl;
}

function selectUpstreamHost(pathname, registry) {
  if (pathname === "/token") {
    return registry.tokenHost || registry.upstream;
  }
  return registry.upstream;
}

function rewriteDockerHubOfficialImagePath(pathname, registry) {
  if (registry.upstream !== REGISTRIES.dockerhub.upstream) {
    return pathname;
  }

  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "v2" || parts.length < 3) {
    return pathname;
  }

  const operationIndex = parts.findIndex((part) =>
    ["manifests", "blobs", "tags"].includes(part),
  );

  if (operationIndex === 2) {
    parts.splice(1, 0, "library");
    return `/${parts.map(encodePathPart).join("/")}`;
  }

  return pathname;
}

function buildUpstreamHeaders(headers) {
  const nextHeaders = new Headers();
  for (const [key, value] of headers.entries()) {
    const lowerKey = key.toLowerCase();
    if (!HOP_BY_HOP_HEADERS.has(lowerKey) && !lowerKey.startsWith("cf-")) {
      nextHeaders.set(key, value);
    }
  }
  return nextHeaders;
}

async function fetchAndNormalize(upstreamRequest, originalUrl, registry, env) {
  const timeoutMs = Number(env.UPSTREAM_TIMEOUT_MS || 30000);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort("upstream_timeout"), timeoutMs);
  let upstreamResponse;

  try {
    upstreamResponse = await fetch(upstreamRequest, { signal: controller.signal });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const upstreamHost = new URL(upstreamRequest.url).hostname;
    return json(
      {
        error: "upstream_fetch_failed",
        upstream: upstreamHost,
        message,
      },
      504,
    );
  } finally {
    clearTimeout(timeoutId);
  }

  const headers = new Headers(upstreamResponse.headers);

  rewriteAuthenticateHeader(headers, originalUrl, registry);
  rewriteLocationHeader(headers, originalUrl, registry);
  headers.set("Docker-Distribution-Api-Version", "registry/2.0");

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
}

function rewriteAuthenticateHeader(headers, originalUrl, registry) {
  const value = headers.get("WWW-Authenticate");
  if (!value) return;

  let rewritten = value;
  for (const host of new Set([registry.upstream, registry.tokenHost].filter(Boolean))) {
    rewritten = rewritten
      .replaceAll(`https://${host}`, originalUrl.origin)
      .replaceAll(`http://${host}`, originalUrl.origin);
  }

  rewritten = rewritten.replaceAll(
    `service="${registry.upstream}"`,
    `service="${registry.authService}"`,
  );

  headers.set("WWW-Authenticate", rewritten);
}

function rewriteLocationHeader(headers, originalUrl, registry) {
  const value = headers.get("Location");
  if (!value) return;

  let rewritten = value;
  for (const host of new Set([registry.upstream, registry.tokenHost].filter(Boolean))) {
    rewritten = rewritten
      .replaceAll(`https://${host}`, originalUrl.origin)
      .replaceAll(`http://${host}`, originalUrl.origin);
  }

  headers.set("Location", rewritten);
}

function shouldUseCache(request, upstreamUrl, env) {
  const mode = String(env.CACHE_MODE || "public").toLowerCase();
  if (mode === "off" || mode === "bypass" || request.method !== "GET") {
    return false;
  }

  if (request.headers.has("Range")) {
    return false;
  }

  return getCacheTtl(upstreamUrl) > 0;
}

function getCacheTtl(url) {
  const pathname = url.pathname;
  if (/\/v2\/.+\/blobs\/sha256:[a-f0-9]{64}$/i.test(pathname)) {
    return 60 * 60 * 24 * 30;
  }

  if (/\/v2\/.+\/manifests\/sha256:[a-f0-9]{64}$/i.test(pathname)) {
    return 60 * 60 * 24 * 7;
  }

  if (/\/v2\/.+\/manifests\/[^/]+$/i.test(pathname)) {
    return 60 * 5;
  }

  if (/\/v2\/.+\/tags\/list$/i.test(pathname)) {
    return 60;
  }

  return 0;
}

function buildCacheRequest(request, upstreamUrl, registry) {
  const cacheUrl = new URL(upstreamUrl.toString());
  cacheUrl.hostname = `${registry.upstream}.cache.local`;

  const accept = request.headers.get("Accept");
  if (accept && upstreamUrl.pathname.includes("/manifests/")) {
    cacheUrl.searchParams.set("__accept", stableHash(accept));
  }

  return new Request(cacheUrl.toString(), { method: "GET" });
}

function isCacheableResponse(response) {
  return (
    response.status >= 200 &&
    response.status < 300 &&
    !response.headers.has("Set-Cookie") &&
    !response.headers.get("Cache-Control")?.toLowerCase().includes("private")
  );
}

function addProxyHeaders(response, registry, cacheStatus, upstreamUrl = null) {
  const headers = new Headers(response.headers);
  const ttl = upstreamUrl ? getCacheTtl(upstreamUrl) : 0;

  headers.set("X-Registry-Upstream", registry.upstream);
  headers.set("X-Registry-Cache", cacheStatus);

  if (cacheStatus !== "BYPASS" && ttl > 0 && isCacheableResponse(response)) {
    headers.set("Cache-Control", `public, max-age=${ttl}`);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function withCors(response) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Authorization, Accept, Content-Type, Range");
  headers.set(
    "Access-Control-Expose-Headers",
    "Docker-Content-Digest, Docker-Distribution-Api-Version, Location, WWW-Authenticate, X-Registry-Cache, X-Registry-Upstream",
  );

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function acceptsHtml(request) {
  return request.headers.get("Accept")?.includes("text/html");
}

function json(body, status = 200, headers = {}) {
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

function encodePathPart(value) {
  return encodeURIComponent(decodeURIComponent(value));
}

function stableHash(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
