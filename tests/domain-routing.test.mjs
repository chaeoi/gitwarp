import assert from "node:assert/strict";
import { test } from "node:test";

import { handleRequest } from "../functions/_lib/handler.js";

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
