import { stableHash } from "./path.js";

export function buildCacheOptions(request, upstreamUrl, registry, env) {
  const mode = String(env.CACHE_MODE || "public").toLowerCase();
  if (mode === "off" || mode === "bypass" || request.method !== "GET") {
    return null;
  }

  if (request.headers.has("Authorization")) {
    return null;
  }

  const ttl = getCacheTtl(upstreamUrl);
  if (ttl <= 0) {
    return null;
  }

  const cacheKey = new URL(upstreamUrl.toString());
  cacheKey.hostname = `${registry.upstream}.cache.local`;

  const accept = request.headers.get("Accept");
  if (accept && upstreamUrl.pathname.includes("/manifests/")) {
    cacheKey.searchParams.set("__accept", stableHash(accept));
  }

  return {
    cacheEverything: true,
    cacheTtl: ttl,
    cacheKey: cacheKey.toString(),
  };
}

export function getCacheTtl(url) {
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

export function isCacheableResponse(response) {
  return (
    response.status >= 200 &&
    response.status < 300 &&
    !response.headers.has("Set-Cookie") &&
    !response.headers.get("Cache-Control")?.toLowerCase().includes("private")
  );
}
