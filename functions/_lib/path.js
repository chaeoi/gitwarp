export function splitPathname(pathname) {
  return pathname.split("/").filter(Boolean).map(decodePathPart);
}

export function buildPathFromParts(parts) {
  if (parts.length === 1 && parts[0].toLowerCase() === "v2") {
    return "/v2/";
  }
  return `/${parts.map(encodePathPart).join("/")}`;
}

export function addStaticV2Prefix(pathname, prefix) {
  const parts = splitPathname(pathname);
  if (parts[0]?.toLowerCase() !== "v2") {
    return pathname;
  }
  if (parts[1]?.toLowerCase() === prefix.toLowerCase()) {
    return pathname;
  }
  return buildPathFromParts(["v2", prefix, ...parts.slice(1)]);
}

export function decodePathPart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function encodePathPart(value) {
  return encodeURIComponent(decodePathPart(value));
}

export function stableHash(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
