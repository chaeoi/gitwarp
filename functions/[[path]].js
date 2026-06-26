const DEFAULT_REGISTRY_KEY = "dockerhub";
const GAR_HOST_PATTERN = /^(?:[a-z0-9-]+-)?docker\.pkg\.dev$/i;
const BROKER_TOKEN = "gitwarp-anonymous";

const REGISTRIES = {
  dockerhub: {
    displayName: "Docker Hub",
    upstream: "registry-1.docker.io",
    tokenHost: "auth.docker.io",
    authService: "registry.docker.io",
    routePrefixes: ["docker.io", "registry-1.docker.io", "index.docker.io"],
    tokenPaths: ["/token", "/token/"],
  },
  ghcr: {
    displayName: "GitHub Container Registry",
    upstream: "ghcr.io",
    tokenHost: "ghcr.io",
    authService: "ghcr.io",
    routePrefixes: ["ghcr.io"],
    tokenPaths: ["/token", "/token/"],
  },
  quay: {
    displayName: "Quay.io",
    upstream: "quay.io",
    tokenHost: "quay.io",
    authService: "quay.io",
    routePrefixes: ["quay.io"],
    tokenPaths: ["/v2/auth", "/v2/auth/"],
  },
  gcr: {
    displayName: "Google Container Registry",
    upstream: "gcr.io",
    tokenHost: "gcr.io",
    authService: "gcr.io",
    routePrefixes: ["gcr.io"],
    tokenPaths: ["/v2/token", "/v2/token/"],
  },
  k8s: {
    displayName: "Kubernetes Registry",
    upstream: "registry.k8s.io",
    tokenHost: "registry.k8s.io",
    authService: "registry.k8s.io",
    routePrefixes: ["registry.k8s.io", "k8s.gcr.io"],
  },
  mcr: {
    displayName: "Microsoft Container Registry",
    upstream: "mcr.microsoft.com",
    tokenHost: "mcr.microsoft.com",
    authService: "mcr.microsoft.com",
    routePrefixes: ["mcr.microsoft.com"],
  },
  ecr: {
    displayName: "Amazon ECR Public",
    upstream: "public.ecr.aws",
    tokenHost: "public.ecr.aws",
    authService: "public.ecr.aws",
    routePrefixes: ["public.ecr.aws"],
    tokenPaths: ["/token", "/token/"],
  },
  gitlab: {
    displayName: "GitLab Container Registry",
    upstream: "registry.gitlab.com",
    tokenHost: "gitlab.com",
    authService: "container_registry",
    serviceAliases: ["container_registry"],
    routePrefixes: ["registry.gitlab.com"],
    tokenPaths: ["/jwt/auth", "/jwt/auth/"],
  },
  nvcr: {
    displayName: "NVIDIA NGC",
    upstream: "nvcr.io",
    tokenHost: "nvcr.io",
    authService: "nvcr.io",
    routePrefixes: ["nvcr.io"],
    tokenPaths: ["/proxy_auth", "/proxy_auth/"],
  },
  lscr: {
    displayName: "LinuxServer.io",
    upstream: "lscr.io",
    tokenHost: "ghcr.io",
    authService: "ghcr.io",
    routePrefixes: ["lscr.io"],
    tokenPaths: ["/token", "/token/"],
  },
  redhat: {
    displayName: "Red Hat Registry",
    upstream: "registry.access.redhat.com",
    tokenHost: "registry.access.redhat.com",
    authService: "registry.access.redhat.com",
    routePrefixes: ["registry.access.redhat.com"],
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
const PREFIX_REGISTRIES = new Map();
const SERVICE_REGISTRIES = new Map();
const TOKEN_PATH_REGISTRIES = new Map();

for (const [key, registry] of Object.entries(REGISTRIES)) {
  registry.key = key;
  for (const prefix of registry.routePrefixes || []) {
    PREFIX_REGISTRIES.set(prefix.toLowerCase(), registry);
  }
  for (const service of getRegistryServices(registry)) {
    if (!SERVICE_REGISTRIES.has(service)) {
      SERVICE_REGISTRIES.set(service, registry);
    }
  }
  for (const tokenPath of registry.tokenPaths || []) {
    if (!TOKEN_PATH_REGISTRIES.has(tokenPath)) {
      TOKEN_PATH_REGISTRIES.set(tokenPath, registry);
    }
  }
}

export async function onRequest(context) {
  const { request, env } = context;
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

  if (isRegistryPing(requestUrl.pathname)) {
    return registryPingResponse(request, requestUrl);
  }

  const brokerToken = await maybeBrokerTokenResponse(request, requestUrl, env);
  if (brokerToken) {
    return brokerToken;
  }

  const route = selectRoute(requestUrl, env);
  if (route?.error) {
    return json(route.error, route.status || 400);
  }

  if (!route) {
    return json(
      {
        error: "registry_route_not_found",
        message:
          "Use Docker Hub at the root path or add the original registry host, for example /v2/ghcr.io/<owner>/<image>/...",
      },
      404,
    );
  }

  const upstreamUrl = buildUpstreamUrl(requestUrl, route);
  const upstreamRequest = new Request(upstreamUrl, {
    method: request.method,
    headers: buildUpstreamHeaders(request.headers),
    redirect: "follow",
  });

  const cacheOptions = buildCacheOptions(request, upstreamUrl, route.registry, env);
  const upstreamResponse = await fetchAndNormalize(upstreamRequest, requestUrl, route, env, cacheOptions);
  return withCors(addProxyHeaders(upstreamResponse, route.registry, upstreamUrl));
}

function selectRoute(requestUrl, env) {
  const authRoute = selectAuthRoute(requestUrl, env);
  if (authRoute) return authRoute;

  const parts = splitPathname(requestUrl.pathname);
  if (parts[0]?.toLowerCase() !== "v2") {
    return null;
  }

  return selectV2Route(requestUrl, parts, env);
}

function selectAuthRoute(requestUrl, env) {
  if (!isAuthRequest(requestUrl)) {
    return null;
  }

  const service = normalizeRegistryValue(requestUrl.searchParams.get("service"));
  const registry = findRegistryByService(service) || findRegistryByTokenPath(requestUrl.pathname);
  const selected = registry || getDefaultRegistry(env);

  return {
    registry: selected,
    upstreamHost: selected.tokenHost || selected.upstream,
    upstreamPathname: requestUrl.pathname,
    routePrefix: null,
    kind: "auth",
  };
}

function selectV2Route(requestUrl, parts, env) {
  const rawPrefix = parts[1];
  if (rawPrefix) {
    const staticRegistry = PREFIX_REGISTRIES.get(rawPrefix.toLowerCase());
    if (staticRegistry) {
      const upstreamPathname = rewriteDockerHubOfficialImagePath(
        buildPathFromParts(["v2", ...parts.slice(2)]),
        staticRegistry,
      );

      return {
        registry: staticRegistry,
        upstreamHost: staticRegistry.upstream,
        upstreamPathname,
        routePrefix: rawPrefix,
        kind: "registry",
      };
    }

    const dynamicHost = normalizeRegistryValue(rawPrefix);
    if (GAR_HOST_PATTERN.test(dynamicHost)) {
      const registry = buildDynamicRegistry(dynamicHost);
      return {
        registry,
        upstreamHost: dynamicHost,
        upstreamPathname: buildPathFromParts(["v2", ...parts.slice(2)]),
        routePrefix: rawPrefix,
        kind: "registry",
      };
    }
  }

  const registry = getDefaultRegistry(env);
  const upstreamPathname = rewriteDockerHubOfficialImagePath(requestUrl.pathname, registry);

  return {
    registry,
    upstreamHost: registry.upstream,
    upstreamPathname,
    routePrefix: null,
    kind: "registry",
  };
}

function isAuthRequest(requestUrl) {
  if (requestUrl.searchParams.has("service") && requestUrl.searchParams.has("scope")) {
    return true;
  }
  if (requestUrl.searchParams.has("service") && TOKEN_PATH_REGISTRIES.has(requestUrl.pathname)) {
    return true;
  }
  if (TOKEN_PATH_REGISTRIES.has(requestUrl.pathname)) {
    return !requestUrl.pathname.startsWith("/v2/") || requestUrl.searchParams.has("scope");
  }
  return requestUrl.pathname === "/proxy_auth" || requestUrl.pathname === "/proxy_auth/";
}

function getDefaultRegistry(env) {
  const explicit = normalizeRegistryValue(env.DEFAULT_REGISTRY || env.REGISTRY || env.UPSTREAM_REGISTRY || "");
  const explicitRegistry = findRegistryByName(explicit);
  if (explicitRegistry) {
    return explicitRegistry;
  }
  return REGISTRIES[DEFAULT_REGISTRY_KEY];
}

function buildUpstreamUrl(requestUrl, route) {
  const upstreamUrl = new URL(requestUrl.toString());
  upstreamUrl.protocol = "https:";
  upstreamUrl.hostname = route.upstreamHost;
  upstreamUrl.port = "";
  upstreamUrl.pathname = route.upstreamPathname;
  return upstreamUrl;
}

function rewriteDockerHubOfficialImagePath(pathname, registry) {
  if (registry.upstream !== REGISTRIES.dockerhub.upstream) {
    return pathname;
  }

  const parts = splitPathname(pathname);
  if (parts[0]?.toLowerCase() !== "v2" || parts.length < 3) {
    return pathname;
  }

  const operationIndex = parts.findIndex((part) =>
    ["manifests", "blobs", "tags"].includes(part.toLowerCase()),
  );

  if (operationIndex === 2) {
    parts.splice(1, 0, "library");
    return buildPathFromParts(parts);
  }

  return pathname;
}

function buildUpstreamHeaders(headers) {
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

async function fetchAndNormalize(upstreamRequest, originalUrl, route, env, cacheOptions) {
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

function buildCacheOptions(request, upstreamUrl, registry, env) {
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

function isCacheableResponse(response) {
  return (
    response.status >= 200 &&
    response.status < 300 &&
    !response.headers.has("Set-Cookie") &&
    !response.headers.get("Cache-Control")?.toLowerCase().includes("private")
  );
}

function addProxyHeaders(response, registry, upstreamUrl = null) {
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

function withCors(response) {
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

function isRegistryPing(pathname) {
  return pathname === "/v2" || pathname === "/v2/";
}

function registryPingResponse(request, requestUrl) {
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

async function maybeBrokerTokenResponse(request, requestUrl, env) {
  if (!isBrokerTokenRequest(requestUrl)) {
    return null;
  }

  const scopes = requestUrl.searchParams.getAll("scope").filter(Boolean);
  if (scopes.length === 0) {
    return brokerTokenResponse();
  }

  const brokerRequest = buildBrokerTokenRequest(requestUrl, scopes);
  if (!brokerRequest) {
    return brokerTokenResponse();
  }

  const upstreamRequest = new Request(brokerRequest.url, {
    method: "GET",
    headers: buildUpstreamHeaders(request.headers),
    redirect: "follow",
  });
  const route = {
    registry: brokerRequest.registry,
    upstreamHost: brokerRequest.registry.tokenHost || brokerRequest.registry.upstream,
    upstreamPathname: brokerRequest.url.pathname,
    routePrefix: null,
    kind: "auth",
  };
  const response = await fetchAndNormalize(upstreamRequest, requestUrl, route, env);
  return withCors(addProxyHeaders(response, brokerRequest.registry));
}

function isBrokerTokenRequest(requestUrl) {
  if (requestUrl.pathname !== "/token" && requestUrl.pathname !== "/token/") {
    return false;
  }
  const service = normalizeRegistryValue(requestUrl.searchParams.get("service"));
  return service === requestUrl.hostname.toLowerCase();
}

function brokerTokenResponse() {
  return withCors(
    new Response(
      JSON.stringify({
        token: BROKER_TOKEN,
        access_token: BROKER_TOKEN,
        expires_in: 300,
        issued_at: new Date().toISOString(),
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Registry-Name": "GitWarp",
          "X-Registry-Upstream": "multi",
          "X-Registry-Cache": "BYPASS",
        },
      },
    ),
  );
}

function buildBrokerTokenRequest(requestUrl, scopes) {
  const mappedScopes = [];
  let registry = null;

  for (const scope of scopes) {
    const mapped = mapBrokerScope(scope);
    if (!mapped) {
      return null;
    }
    if (registry && registry.upstream !== mapped.registry.upstream) {
      return null;
    }
    registry = mapped.registry;
    mappedScopes.push(mapped.scope);
  }

  if (!registry?.tokenPaths?.length) {
    return null;
  }

  const url = new URL(requestUrl.toString());
  url.protocol = "https:";
  url.hostname = registry.tokenHost || registry.upstream;
  url.port = "";
  url.pathname = registry.tokenPaths[0];
  url.search = "";

  for (const [key, value] of requestUrl.searchParams.entries()) {
    if (key !== "service" && key !== "scope") {
      url.searchParams.append(key, value);
    }
  }
  url.searchParams.set("service", registry.authService);
  for (const scope of mappedScopes) {
    url.searchParams.append("scope", scope);
  }

  return { registry, url };
}

function mapBrokerScope(scope) {
  const match = /^repository:([^:]+):(.+)$/.exec(scope);
  if (!match) {
    return null;
  }

  const mapped = mapRepositoryName(match[1]);
  if (!mapped) {
    return null;
  }

  return {
    registry: mapped.registry,
    scope: `repository:${mapped.name}:${match[2]}`,
  };
}

function mapRepositoryName(name) {
  const parts = name.split("/").filter(Boolean);
  const prefix = parts[0]?.toLowerCase();

  if (prefix && PREFIX_REGISTRIES.has(prefix)) {
    const registry = PREFIX_REGISTRIES.get(prefix);
    const upstreamName = rewriteDockerHubRepositoryName(parts.slice(1).join("/"), registry);
    return upstreamName ? { registry, name: upstreamName } : null;
  }

  if (prefix && GAR_HOST_PATTERN.test(prefix)) {
    const registry = buildDynamicRegistry(prefix);
    const upstreamName = parts.slice(1).join("/");
    return upstreamName ? { registry, name: upstreamName } : null;
  }

  const registry = REGISTRIES[DEFAULT_REGISTRY_KEY];
  return { registry, name: rewriteDockerHubRepositoryName(name, registry) };
}

function rewriteDockerHubRepositoryName(name, registry) {
  if (registry.upstream !== REGISTRIES.dockerhub.upstream) {
    return name;
  }
  if (!name || name.includes("/")) {
    return name;
  }
  return `library/${name}`;
}

function isBrokerAuthorization(value) {
  return value.trim().toLowerCase() === `bearer ${BROKER_TOKEN}`;
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

function getRegistryServices(registry) {
  return [
    registry.authService,
    registry.upstream,
    registry.tokenHost,
    ...(registry.serviceAliases || []),
  ]
    .filter(Boolean)
    .map(normalizeRegistryValue);
}

function getRegistryHosts(registry) {
  return [...new Set([registry.upstream, registry.tokenHost].filter(Boolean).map(normalizeRegistryValue))];
}

function findRegistryByName(value) {
  if (!value) return null;
  if (REGISTRIES[value]) return REGISTRIES[value];
  if (PREFIX_REGISTRIES.has(value)) return PREFIX_REGISTRIES.get(value);
  return Object.values(REGISTRIES).find((registry) => getRegistryServices(registry).includes(value));
}

function findRegistryByService(service) {
  if (!service) return null;
  if (SERVICE_REGISTRIES.has(service)) {
    return SERVICE_REGISTRIES.get(service);
  }

  if (GAR_HOST_PATTERN.test(service)) {
    return buildDynamicRegistry(service);
  }

  return null;
}

function findRegistryByTokenPath(pathname) {
  return TOKEN_PATH_REGISTRIES.get(pathname) || null;
}

function buildDynamicRegistry(upstreamHost) {
  return {
    key: `gar:${upstreamHost}`,
    displayName: `Google Artifact Registry (${upstreamHost})`,
    upstream: upstreamHost,
    tokenHost: upstreamHost,
    authService: upstreamHost,
    routePrefixes: [upstreamHost],
    tokenPaths: ["/v2/token", "/v2/token/"],
  };
}

function normalizeRegistryValue(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
}

function splitPathname(pathname) {
  return pathname.split("/").filter(Boolean).map(decodePathPart);
}

function buildPathFromParts(parts) {
  if (parts.length === 1 && parts[0].toLowerCase() === "v2") {
    return "/v2/";
  }
  return `/${parts.map(encodePathPart).join("/")}`;
}

function addStaticV2Prefix(pathname, prefix) {
  const parts = splitPathname(pathname);
  if (parts[0]?.toLowerCase() !== "v2") {
    return pathname;
  }
  if (parts[1]?.toLowerCase() === prefix.toLowerCase()) {
    return pathname;
  }
  return buildPathFromParts(["v2", prefix, ...parts.slice(1)]);
}

function decodePathPart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function encodePathPart(value) {
  return encodeURIComponent(decodePathPart(value));
}

function stableHash(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
