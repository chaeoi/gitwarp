import { GAR_HOST_PATTERN } from "./constants.js";
import { rewriteDockerHubOfficialImagePath } from "./dockerhub.js";
import {
  PREFIX_REGISTRIES,
  TOKEN_PATH_REGISTRIES,
  buildDynamicRegistry,
  findRegistryByService,
  findRegistryByTokenPath,
  getDefaultRegistry,
  normalizeRegistryValue,
} from "./registries.js";
import { buildPathFromParts, splitPathname } from "./path.js";

export function selectRoute(requestUrl, env) {
  const authRoute = selectAuthRoute(requestUrl, env);
  if (authRoute) return authRoute;

  const parts = splitPathname(requestUrl.pathname);
  if (parts[0]?.toLowerCase() !== "v2") {
    return null;
  }

  return selectV2Route(requestUrl, parts, env);
}

export function isRegistryPing(pathname) {
  return pathname === "/v2" || pathname === "/v2/";
}

function selectAuthRoute(requestUrl, env) {
  if (!isAuthRequest(requestUrl)) {
    return null;
  }

  const service = normalizeRegistryValue(requestUrl.searchParams.get("service"));
  const serviceRegistry = findRegistryByService(service);
  if (service && !serviceRegistry) {
    return {
      error: {
        error: "unknown_auth_service",
        message: "Token requests must use this site's service value or a supported upstream registry service.",
      },
      status: 400,
    };
  }

  const registry = serviceRegistry || findRegistryByTokenPath(requestUrl.pathname);
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
