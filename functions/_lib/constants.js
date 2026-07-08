export const DEFAULT_REGISTRY_KEY = "dockerhub";
export const GAR_HOST_PATTERN = /^(?:[a-z0-9-]+-)?docker\.pkg\.dev$/i;
export const BROKER_TOKEN = "gitwarp-anonymous";

export const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const HOP_BY_HOP_HEADERS = new Set([
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
