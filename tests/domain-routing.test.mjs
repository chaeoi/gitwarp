import assert from "node:assert/strict";
import { test } from "node:test";

import { handleRequest } from "../functions/_lib/handler.js";
import {
  buildGitHubSourceUrl,
  getGitHubSourceCacheTtl,
  selectGitHubSourceRoute,
} from "../functions/_lib/github-source.js";
import { selectRoute } from "../functions/_lib/routes.js";

const env = {
  ASSETS: {
    fetch: () => new Response("asset", { status: 200 }),
  },
};

async function request(url, init) {
  return handleRequest({ request: new Request(url, init), env });
}

test("registry challenge uses the incoming custom domain", async () => {
  const response = await request("https://mirror.example.com/v2/");

  assert.equal(response.status, 401);
  assert.equal(
    response.headers.get("WWW-Authenticate"),
    'Bearer realm="https://mirror.example.com/token",service="mirror.example.com"',
  );
});

test("broker token accepts the incoming custom domain service", async () => {
  const response = await request("https://mirror.example.com/token?service=mirror.example.com");
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.token, "gitwarp-anonymous");
  assert.equal(body.access_token, "gitwarp-anonymous");
});

test("broker token keeps local hosts with ports in the service value", async () => {
  const ping = await request("https://127.0.0.1:8788/v2/");
  const token = await request("https://127.0.0.1:8788/token?service=127.0.0.1:8788");

  assert.equal(
    ping.headers.get("WWW-Authenticate"),
    'Bearer realm="https://127.0.0.1:8788/token",service="127.0.0.1:8788"',
  );
  assert.equal(token.status, 200);
});

test("unknown service values are not treated as the current site", async () => {
  const response = await request("https://mirror.example.com/token?service=gitwarp-crn.pages.dev");
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error, "unknown_auth_service");
});

test("raw GitHub paths proxy the complete public source path", () => {
  const requestUrl = new URL(
    "https://mirror.example.com/raw.githubusercontent.com/chaeoi/robotinit/main/scripts/sanitize.sh?download=1",
  );
  const route = selectGitHubSourceRoute(requestUrl);
  const upstreamUrl = buildGitHubSourceUrl(requestUrl, route);

  assert.equal(route.upstreamHost, "raw.githubusercontent.com");
  assert.equal(route.upstreamPathname, "/chaeoi/robotinit/main/scripts/sanitize.sh");
  assert.equal(
    upstreamUrl.toString(),
    "https://raw.githubusercontent.com/chaeoi/robotinit/main/scripts/sanitize.sh?download=1",
  );
});

test("codeload GitHub paths proxy source archives", () => {
  const requestUrl = new URL(
    "https://mirror.example.com/codeload.github.com/owner/repo/zip/refs/heads/main",
  );
  const route = selectGitHubSourceRoute(requestUrl);
  const upstreamUrl = buildGitHubSourceUrl(requestUrl, route);

  assert.equal(route.upstreamHost, "codeload.github.com");
  assert.equal(upstreamUrl.toString(), "https://codeload.github.com/owner/repo/zip/refs/heads/main");
});

test("GitHub release asset paths proxy versioned downloads", () => {
  const requestUrl = new URL(
    "https://mirror.example.com/github.com/chaeoi/baize/releases/download/20260815/baize-agent-linux-arm64?download=1",
  );
  const route = selectGitHubSourceRoute(requestUrl);
  const upstreamUrl = buildGitHubSourceUrl(requestUrl, route);

  assert.equal(route.upstreamHost, "github.com");
  assert.equal(
    route.upstreamPathname,
    "/chaeoi/baize/releases/download/20260815/baize-agent-linux-arm64",
  );
  assert.equal(
    upstreamUrl.toString(),
    "https://github.com/chaeoi/baize/releases/download/20260815/baize-agent-linux-arm64?download=1",
  );
  assert.equal(getGitHubSourceCacheTtl(upstreamUrl), 60 * 5);
});

test("GitHub latest release asset paths are supported", () => {
  const requestUrl = new URL(
    "https://mirror.example.com/github.com/owner/repo/releases/latest/download/app-linux-amd64",
  );
  const route = selectGitHubSourceRoute(requestUrl);

  assert.equal(route.upstreamHost, "github.com");
  assert.equal(
    buildGitHubSourceUrl(requestUrl, route).toString(),
    "https://github.com/owner/repo/releases/latest/download/app-linux-amd64",
  );
});

test("GitHub source routing uses exact allowlisted host prefixes", () => {
  assert.equal(
    selectGitHubSourceRoute(new URL("https://mirror.example.com/raw.githubusercontent.com.evil/file")),
    null,
  );
  assert.equal(selectGitHubSourceRoute(new URL("https://mirror.example.com/raw-file")), null);

  const missingPath = selectGitHubSourceRoute(
    new URL("https://mirror.example.com/raw.githubusercontent.com/"),
  );
  assert.equal(missingPath.status, 400);
  assert.equal(missingPath.error.error, "github_source_path_required");
});

test("GitHub web pages outside release asset downloads are rejected", () => {
  for (const pathname of [
    "/github.com/owner/repo",
    "/github.com/owner/repo/releases",
    "/github.com/owner/repo/archive/refs/heads/main.zip",
    "/github.com/owner/repo/releases/download/tag",
  ]) {
    const route = selectGitHubSourceRoute(new URL(`https://mirror.example.com${pathname}`));
    assert.equal(route.status, 400);
    assert.equal(route.error.error, "github_release_path_invalid");
  }

  assert.equal(
    selectGitHubSourceRoute(
      new URL(
        "https://mirror.example.com/github.com.evil/owner/repo/releases/download/tag/asset",
      ),
    ),
    null,
  );
});

test("commit-addressed GitHub sources receive the immutable cache TTL", () => {
  const commit = "0123456789abcdef0123456789abcdef01234567";
  const immutableUrl = new URL(`https://raw.githubusercontent.com/owner/repo/${commit}/file`);
  const branchUrl = new URL("https://raw.githubusercontent.com/owner/repo/main/file");
  const commitLikeFilename = new URL(`https://raw.githubusercontent.com/owner/repo/main/${commit}`);

  assert.equal(getGitHubSourceCacheTtl(immutableUrl), 60 * 60 * 24 * 30);
  assert.equal(getGitHubSourceCacheTtl(branchUrl), 60 * 5);
  assert.equal(getGitHubSourceCacheTtl(commitLikeFilename), 60 * 5);
});

test("source host names inside v2 remain Docker registry paths", () => {
  const route = selectRoute(
    new URL("https://mirror.example.com/v2/raw.githubusercontent.com/owner/repo/manifests/latest"),
    env,
  );

  assert.equal(route.kind, "registry");
  assert.equal(route.registry.key, "dockerhub");
  assert.equal(route.upstreamHost, "registry-1.docker.io");
});

test("registry auth parameters do not turn arbitrary paths into token routes", () => {
  const route = selectRoute(
    new URL("https://mirror.example.com/not-a-token?service=ghcr.io&scope=repository:owner/image:pull"),
    env,
  );

  assert.equal(route, null);
});

test("registered token paths still select their requested registries", () => {
  const route = selectRoute(
    new URL("https://mirror.example.com/v2/auth?service=quay.io&scope=repository:owner/image:pull"),
    env,
  );

  assert.equal(route.kind, "auth");
  assert.equal(route.registry.key, "quay");
  assert.equal(route.upstreamHost, "quay.io");
  assert.equal(route.upstreamPathname, "/v2/auth");
});

test("GitHub source requests strip credentials and omit Docker response headers", async () => {
  const originalFetch = globalThis.fetch;
  let capturedRequest;
  let capturedInit;

  globalThis.fetch = async (upstreamRequest, init) => {
    capturedRequest = upstreamRequest;
    capturedInit = init;
    return new Response("source", {
      headers: {
        "Content-Type": "text/plain",
        ETag: '"source-etag"',
      },
    });
  };

  try {
    const response = await request(
      "https://mirror.example.com/raw.githubusercontent.com/owner/repo/main/file.sh",
      {
        headers: {
          Authorization: "Bearer secret",
          Cookie: "session=secret",
          Range: "bytes=0-99",
        },
      },
    );

    assert.equal(capturedRequest.url, "https://raw.githubusercontent.com/owner/repo/main/file.sh");
    assert.equal(capturedRequest.headers.has("Authorization"), false);
    assert.equal(capturedRequest.headers.has("Cookie"), false);
    assert.equal(capturedRequest.headers.get("Accept-Encoding"), "identity");
    assert.equal(capturedRequest.headers.get("Range"), "bytes=0-99");
    assert.equal(capturedInit.cf.cacheEverything, true);
    assert.equal(capturedInit.cf.cacheTtl, 60 * 5);
    assert.equal(response.headers.get("Docker-Distribution-Api-Version"), null);
    assert.equal(response.headers.get("X-GitHub-Source-Upstream"), "raw.githubusercontent.com");
    assert.equal(await response.text(), "source");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GitHub release requests follow the upstream asset redirect", async () => {
  const originalFetch = globalThis.fetch;
  let capturedRequest;

  globalThis.fetch = async (upstreamRequest) => {
    capturedRequest = upstreamRequest;
    return new Response("release", {
      headers: {
        "Content-Disposition": "attachment; filename=baize-agent-linux-arm64",
      },
    });
  };

  try {
    const response = await request(
      "https://mirror.example.com/github.com/chaeoi/baize/releases/download/20260815/baize-agent-linux-arm64",
      { headers: { Range: "bytes=0-99" } },
    );

    assert.equal(
      capturedRequest.url,
      "https://github.com/chaeoi/baize/releases/download/20260815/baize-agent-linux-arm64",
    );
    assert.equal(capturedRequest.redirect, "follow");
    assert.equal(capturedRequest.headers.get("Range"), "bytes=0-99");
    assert.equal(response.headers.get("X-GitHub-Source-Upstream"), "github.com");
    assert.equal(response.headers.get("Content-Disposition"), "attachment; filename=baize-agent-linux-arm64");
    assert.equal(await response.text(), "release");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
