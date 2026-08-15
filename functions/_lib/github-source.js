import { buildUpstreamHeaders, json, withCors } from "./http.js";

const GITHUB_SOURCE_HOSTS = new Set([
  "raw.githubusercontent.com",
  "codeload.github.com",
  "github.com",
]);
const VERSIONED_RELEASE_PATH_PATTERN =
  /^\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/[^/]+$/;
const LATEST_RELEASE_PATH_PATTERN =
  /^\/[^/]+\/[^/]+\/releases\/latest\/download\/[^/]+$/;
const GITHUB_RELEASE_PATH_PATTERNS = [
  VERSIONED_RELEASE_PATH_PATTERN,
  LATEST_RELEASE_PATH_PATTERN,
];
const DEFAULT_CACHE_TTL = 60 * 5;
const RELEASE_CACHE_TTL = 60 * 60 * 24;
const IMMUTABLE_CACHE_TTL = 60 * 60 * 24 * 30;
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/i;

export async function maybeGitHubSourceResponse(request, requestUrl, env, context) {
  const route = selectGitHubSourceRoute(requestUrl);
  if (!route) {
    return null;
  }
  if (route.error) {
    return json(route.error, route.status || 400);
  }

  const upstreamUrl = buildGitHubSourceUrl(requestUrl, route);
  const cachedResponse = await matchGitHubSourceCache(request, requestUrl, env);
  if (cachedResponse) {
    const response = request.method === "HEAD" ? withoutBody(cachedResponse) : cachedResponse;
    return withCors(addGitHubSourceHeaders(response, upstreamUrl, "HIT"));
  }

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

  const response = withCors(addGitHubSourceHeaders(upstreamResponse, upstreamUrl));
  scheduleGitHubSourceCache(request, requestUrl, env, context, response);
  return response;
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

  const upstreamPathname = pathname.slice(hostEnd);
  if (
    host === "github.com" &&
    !GITHUB_RELEASE_PATH_PATTERNS.some((pattern) => pattern.test(upstreamPathname))
  ) {
    return {
      error: {
        error: "github_release_path_invalid",
        message:
          "Only GitHub release asset paths under /<owner>/<repo>/releases/download/ or /releases/latest/download/ are supported.",
      },
      status: 400,
    };
  }

  return {
    kind: "github-source",
    upstreamHost: host,
    upstreamPathname,
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
  };
}

export function getGitHubSourceCacheTtl(upstreamUrl) {
  if (
    upstreamUrl.hostname === "github.com" &&
    VERSIONED_RELEASE_PATH_PATTERN.test(upstreamUrl.pathname)
  ) {
    return RELEASE_CACHE_TTL;
  }

  const parts = upstreamUrl.pathname.split("/").filter(Boolean);
  let ref;
  if (upstreamUrl.hostname === "raw.githubusercontent.com") {
    ref = parts[2];
  } else if (upstreamUrl.hostname === "codeload.github.com") {
    ref = parts[3];
  }
  return COMMIT_SHA_PATTERN.test(ref || "") ? IMMUTABLE_CACHE_TTL : DEFAULT_CACHE_TTL;
}

function addGitHubSourceHeaders(response, upstreamUrl, cacheStatus = null) {
  const headers = new Headers(response.headers);
  const ttl = getGitHubSourceCacheTtl(upstreamUrl);

  headers.set("X-GitHub-Source-Upstream", upstreamUrl.hostname);
  headers.set(
    "X-GitHub-Source-Cache",
    cacheStatus || headers.get("CF-Cache-Status") || "DYNAMIC",
  );

  if (isCacheableResponse(response)) {
    headers.set("Cache-Control", `public, max-age=${ttl}`);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function matchGitHubSourceCache(request, requestUrl, env) {
  const cache = getGitHubSourceCache(request, env);
  if (!cache) {
    return null;
  }

  try {
    return await cache.match(buildGitHubSourceCacheRequest(requestUrl, request.headers.get("Range")));
  } catch {
    return null;
  }
}

function scheduleGitHubSourceCache(request, requestUrl, env, context, response) {
  const cache = getGitHubSourceCache(request, env);
  if (
    !cache ||
    request.method !== "GET" ||
    request.headers.has("Range") ||
    response.status !== 200 ||
    !isCacheableResponse(response) ||
    typeof context?.waitUntil !== "function"
  ) {
    return;
  }

  const cacheRequest = buildGitHubSourceCacheRequest(requestUrl);
  const cacheWrite = cache.put(cacheRequest, response.clone()).catch(() => undefined);
  context.waitUntil(cacheWrite);
}

function getGitHubSourceCache(request, env) {
  const mode = String(env.CACHE_MODE || "public").toLowerCase();
  if (
    mode === "off" ||
    mode === "bypass" ||
    (request.method !== "GET" && request.method !== "HEAD")
  ) {
    return null;
  }
  return globalThis.caches?.default || null;
}

function buildGitHubSourceCacheRequest(requestUrl, range = null) {
  const headers = new Headers();
  if (range) {
    headers.set("Range", range);
  }
  return new Request(requestUrl.toString(), { method: "GET", headers });
}

function withoutBody(response) {
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
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
