import { DEFAULT_REGISTRY_KEY, GAR_HOST_PATTERN } from "./constants.js";

export const REGISTRIES = {
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

export const PREFIX_REGISTRIES = new Map();
export const SERVICE_REGISTRIES = new Map();
export const TOKEN_PATH_REGISTRIES = new Map();

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

export function getDefaultRegistry(env) {
  const explicit = normalizeRegistryValue(env.DEFAULT_REGISTRY || env.REGISTRY || env.UPSTREAM_REGISTRY || "");
  const explicitRegistry = findRegistryByName(explicit);
  if (explicitRegistry) {
    return explicitRegistry;
  }
  return REGISTRIES[DEFAULT_REGISTRY_KEY];
}

export function getRegistryServices(registry) {
  return [
    registry.authService,
    registry.upstream,
    registry.tokenHost,
    ...(registry.serviceAliases || []),
  ]
    .filter(Boolean)
    .map(normalizeRegistryValue);
}

export function getRegistryHosts(registry) {
  return [...new Set([registry.upstream, registry.tokenHost].filter(Boolean).map(normalizeRegistryValue))];
}

export function findRegistryByName(value) {
  if (!value) return null;
  if (REGISTRIES[value]) return REGISTRIES[value];
  if (PREFIX_REGISTRIES.has(value)) return PREFIX_REGISTRIES.get(value);
  return Object.values(REGISTRIES).find((registry) => getRegistryServices(registry).includes(value));
}

export function findRegistryByService(service) {
  if (!service) return null;
  if (SERVICE_REGISTRIES.has(service)) {
    return SERVICE_REGISTRIES.get(service);
  }

  if (GAR_HOST_PATTERN.test(service)) {
    return buildDynamicRegistry(service);
  }

  return null;
}

export function findRegistryByTokenPath(pathname) {
  return TOKEN_PATH_REGISTRIES.get(pathname) || null;
}

export function buildDynamicRegistry(upstreamHost) {
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

export function normalizeRegistryValue(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
}
