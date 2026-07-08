import { BROKER_TOKEN, DEFAULT_REGISTRY_KEY, GAR_HOST_PATTERN } from "./constants.js";
import { rewriteDockerHubRepositoryName } from "./dockerhub.js";
import { buildUpstreamHeaders, withCors } from "./http.js";
import { PREFIX_REGISTRIES, REGISTRIES, buildDynamicRegistry, normalizeRegistryValue } from "./registries.js";
import { addProxyHeaders, fetchAndNormalize } from "./upstream.js";

export async function maybeBrokerTokenResponse(request, requestUrl, env) {
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
