import { normalizeRegistryValue } from "./registries.js";

export function getPublicOrigin(requestUrl) {
  return requestUrl.origin;
}

export function getPublicService(requestUrl) {
  return requestUrl.host.toLowerCase();
}

export function isCurrentHostService(requestUrl, service) {
  return normalizeRegistryValue(service) === getPublicService(requestUrl);
}
