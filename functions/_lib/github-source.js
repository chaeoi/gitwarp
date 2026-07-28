import { buildUpstreamHeaders, json, withCors } from "./http.js";

const GITHUB_SOURCE_HOSTS = new Set(["raw.githubusercontent.com", "codeload.github.com"]);
const DEFAULT_CACHE_TTL = 60 * 5;
const IMMUTABLE_CACHE_TTL = 60 * 60 * 24 * 30;
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/i;

export async function maybeGitHubSourceResponse(request, requestUrl, env) {
  const route = selectGitHubSourceRoute(requestUrl);
  if (!route) {
    return null;
  }
  if (route.error) {
    return json(route.error, route.status || 400);
  }

  const upstreamUrl = buildGitHubSourceUrl(requestUrl, route);
  const upstreamHeaders = buildUpstreamHeaders(request.headers);
  upstreamHeaders.delete("Authorization");
  upstreamHeaders.delete("Cookie");
  upstreamHeaders.set("Accept-Encoding", "identity");

  const upstreamRequest = new Request(upstreamUrl, {
    method: request.method,
    headers: upstreamHeaders,
    redirect: "follow",
  });
  const cacheOptions = buildGitHubSourceCacheOptions(request, upstreamUrl, env);
  const timeoutMs = getTimeoutMs(env);
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
    return json(
      {
        error: "upstream_fetch_failed",
        upstream: route.upstreamHost,
        message,
      },
      504,
    );
  } finally {
    clearTimeout(timeoutId);
  }

  return withCors(addGitHubSourceHeaders(upstreamResponse, upstreamUrl));
}

export function selectGitHubSourceRoute(requestUrl) {
  const pathname = requestUrl.pathname;
  const hostEnd = pathname.indexOf("/", 1);
  const host = pathname.slice(1, hostEnd === -1 ? undefined : hostEnd).toLowerCase();

  if (!GITHUB_SOURCE_HOSTS.has(host)) {
    return null;
  }

  if (hostEnd === -1 || hostEnd === pathname.length - 1) {
    return {
      error: {
        error: "github_source_path_required",
        message: `Add the GitHub source path after /${host}/.`,
      },
      status: 400,
    };
  }

  return {
    kind: "github-source",
    upstreamHost: host,
    upstreamPathname: pathname.slice(hostEnd),
  };
}

export function buildGitHubSourceUrl(requestUrl, route) {
  const upstreamUrl = new URL(`https://${route.upstreamHost}`);
  upstreamUrl.pathname = route.upstreamPathname;
  upstreamUrl.search = requestUrl.search;
  return upstreamUrl;
}

export function buildGitHubSourceCacheOptions(request, upstreamUrl, env) {
  const mode = String(env.CACHE_MODE || "public").toLowerCase();
  if (mode === "off" || mode === "bypass" || request.method !== "GET") {
    return null;
  }

  const ttl = getGitHubSourceCacheTtl(upstreamUrl);
  return {
    cacheEverything: true,
    cacheTtl: ttl,
    cacheKey: upstreamUrl.toString(),
  };
}

export function getGitHubSourceCacheTtl(upstreamUrl) {
  const parts = upstreamUrl.pathname.split("/").filter(Boolean);
  const ref = upstreamUrl.hostname === "raw.githubusercontent.com" ? parts[2] : parts[3];
  return COMMIT_SHA_PATTERN.test(ref || "") ? IMMUTABLE_CACHE_TTL : DEFAULT_CACHE_TTL;
}

function addGitHubSourceHeaders(response, upstreamUrl) {
  const headers = new Headers(response.headers);
  const ttl = getGitHubSourceCacheTtl(upstreamUrl);

  headers.set("X-GitHub-Source-Upstream", upstreamUrl.hostname);
  headers.set("X-GitHub-Source-Cache", headers.get("CF-Cache-Status") || "DYNAMIC");

  if (isCacheableResponse(response)) {
    headers.set("Cache-Control", `public, max-age=${ttl}`);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isCacheableResponse(response) {
  return (
    response.status >= 200 &&
    response.status < 300 &&
    !response.headers.has("Set-Cookie") &&
    !response.headers.get("Cache-Control")?.toLowerCase().includes("private")
  );
}

function getTimeoutMs(env) {
  const timeoutMs = Number(env.UPSTREAM_TIMEOUT_MS || 30000);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000;
}
