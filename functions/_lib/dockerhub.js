import { REGISTRIES } from "./registries.js";
import { buildPathFromParts, splitPathname } from "./path.js";

export function rewriteDockerHubOfficialImagePath(pathname, registry) {
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

export function rewriteDockerHubRepositoryName(name, registry) {
  if (registry.upstream !== REGISTRIES.dockerhub.upstream) {
    return name;
  }
  if (!name || name.includes("/")) {
    return name;
  }
  return `library/${name}`;
}
