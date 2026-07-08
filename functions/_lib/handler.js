import { READ_METHODS } from "./constants.js";
import { maybeBrokerTokenResponse } from "./auth.js";
import { buildCacheOptions } from "./cache.js";
import { buildUpstreamHeaders, json, withCors } from "./http.js";
import { registryPingResponse } from "./responses.js";
import { isRegistryPing, selectRoute } from "./routes.js";
import { addProxyHeaders, buildUpstreamUrl, fetchAndNormalize } from "./upstream.js";

export async function handleRequest(context) {
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

  if (shouldServeAsset(requestUrl, request)) {
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

function shouldServeAsset(requestUrl, request) {
  if (requestUrl.pathname === "/") {
    return request.method === "GET" || request.method === "HEAD";
  }
  return requestUrl.pathname === "/favicon.ico" || requestUrl.pathname.startsWith("/assets/");
}
