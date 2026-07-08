import { GAR_HOST_PATTERN } from "./constants.js";
import { getCacheTtl, isCacheableResponse } from "./cache.js";
import { json } from "./http.js";
import { addStaticV2Prefix } from "./path.js";
import { getRegistryHosts } from "./registries.js";

export function buildUpstreamUrl(requestUrl, route) {
  const upstreamUrl = new URL(requestUrl.toString());
  upstreamUrl.protocol = "https:";
  upstreamUrl.hostname = route.upstreamHost;
  upstreamUrl.port = "";
  upstreamUrl.pathname = route.upstreamPathname;
  return upstreamUrl;
}

export async function fetchAndNormalize(upstreamRequest, originalUrl, route, env, cacheOptions) {
  const timeoutMs = Number(env.UPSTREAM_TIMEOUT_MS || 30000);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort("upstream_timeout"), timeoutMs);
  let upstreamResponse;

  try {
    const init = { signal: controller.signal };
    if (cacheOptions) {
      init.cf = cacheOptions;
    }
    upstreamResponse = await fetch(upstreamRequest, init);
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
  rewriteAuthenticateHeader(headers, originalUrl, route.registry);
  rewriteLocationHeader(headers, originalUrl, route);
  headers.set("Docker-Distribution-Api-Version", "registry/2.0");

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
}

export function addProxyHeaders(response, registry, upstreamUrl = null) {
  const headers = new Headers(response.headers);
  const ttl = upstreamUrl ? getCacheTtl(upstreamUrl) : 0;

  headers.set("X-Registry-Name", registry.displayName);
  headers.set("X-Registry-Upstream", registry.upstream);
  headers.set("X-Registry-Cache", headers.get("CF-Cache-Status") || "DYNAMIC");

  if (ttl > 0 && isCacheableResponse(response)) {
    headers.set("Cache-Control", `public, max-age=${ttl}`);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function rewriteAuthenticateHeader(headers, originalUrl, registry) {
  const value = headers.get("WWW-Authenticate");
  if (!value) return;

  let rewritten = value;
  for (const host of getRegistryHosts(registry)) {
    rewritten = rewritten
      .replaceAll(`https://${host}`, originalUrl.origin)
      .replaceAll(`http://${host}`, originalUrl.origin);
  }

  rewritten = rewritten
    .replaceAll(`service="${registry.upstream}"`, `service="${registry.authService}"`)
    .replaceAll(`service=${registry.upstream}`, `service=${registry.authService}`);

  headers.set("WWW-Authenticate", rewritten);
}

function rewriteLocationHeader(headers, originalUrl, route) {
  const value = headers.get("Location");
  if (!value) return;

  const rewritten = rewriteLocationUrl(value, originalUrl, route);
  if (rewritten) {
    headers.set("Location", rewritten);
  }
}

function rewriteLocationUrl(value, originalUrl, route) {
  let locationUrl;
  try {
    locationUrl = new URL(value);
  } catch {
    return value;
  }

  const originalHost = locationUrl.hostname.toLowerCase();

  if (GAR_HOST_PATTERN.test(originalHost)) {
    locationUrl.protocol = originalUrl.protocol;
    locationUrl.host = originalUrl.host;
    locationUrl.pathname = addStaticV2Prefix(locationUrl.pathname, originalHost);
    return locationUrl.toString();
  }

  if (!getRegistryHosts(route.registry).includes(originalHost)) {
    return value;
  }

  locationUrl.protocol = originalUrl.protocol;
  locationUrl.host = originalUrl.host;
  if (route.kind === "registry" && route.routePrefix && locationUrl.pathname.startsWith("/v2/")) {
    locationUrl.pathname = addStaticV2Prefix(locationUrl.pathname, route.routePrefix);
  }
  return locationUrl.toString();
}
