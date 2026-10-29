import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { createHttpServer, resolveRuntimeMode } from "../src/server.js";

const SHOP_PATH = "/oauth/tiktok-shop/callback";
const CODE_CANARY = "offline-shop-code-canary-not-a-real-code";
const COOKIE_CANARY = "offline-cookie-canary-not-a-real-cookie";
const CHANNEL_SECRET = "offline-fixture-channel-secret";

async function invoke(server, { method = "GET", url = "/", headers = {}, body = "" } = {}) {
  const request = {
    method, url, headers, socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(body); }
  };
  const result = { status: null, headers: null, body: null };
  const response = {
    writeHead(status, responseHeaders) { result.status = status; result.headers = responseHeaders; },
    end(value) { result.body = String(value ?? ""); }
  };
  await server.listeners("request")[0](request, response);
  return result;
}

function fixture() {
  const calls = [];
  const logs = [];
  const config = { clients: [{ id: "offline-pilot", lineControl: { enabled: true, autoBoost: { enabled: true } },
    telemetry: { source: "chrome-ui", maxSnapshotAgeSeconds: 120 } }] };
  const runtime = resolveRuntimeMode({ CONTROL_PLANE_ONLY: "true", CHROME_TELEMETRY_ENABLED: "true",
    CHROME_TELEMETRY_ALERTS_ENABLED: "true" });
  const server = createHttpServer({
    service: { executionEnabled: false, async handleLineEvents(events) { calls.push(["line", events]); return [{ status: "PROCESSED" }]; } },
    store: { listLatestTelemetry() { calls.push(["telemetry-read"]); return [{ clientId: "offline-pilot", observedAt: "2026-07-21T05:31:50.634Z" }]; } },
    channelSecret: CHANNEL_SECRET, adminApiKey: "x".repeat(43), runtime, config,
    clock: () => new Date("2026-10-29T15:30:00.000Z"),
    logger: { error(...args) { logs.push(args); } }
  });
  return { server, calls, logs };
}

test("production server rejects plain Shop callback while unconfigured without touching Ads services", async () => {
  const f = fixture();
  const result = await invoke(f.server, { url: SHOP_PATH });
  assert.equal(result.status, 503);
  assert.match(result.body, /not configured/);
  assert.equal(result.headers["Cache-Control"], "no-store");
  assert.equal(result.headers["Referrer-Policy"], "no-referrer");
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.logs, []);
});

test("production Shop dispatch never logs or reflects callback query values or cookies", async (t) => {
  const consoleCalls = [];
  for (const method of ["log", "warn", "error", "info", "debug"]) t.mock.method(console, method, (...args) => consoleCalls.push(args));
  const f = fixture();
  const result = await invoke(f.server, { url: `${SHOP_PATH}?code=${CODE_CANARY}&state=offline-state`,
    headers: { cookie: `binding=${COOKIE_CANARY}` } });
  assert.equal(result.status, 503);
  const externallyVisible = JSON.stringify({ result, logs: f.logs, consoleCalls });
  for (const sensitive of [CODE_CANARY, COOKIE_CANARY, "offline-state"]) assert.equal(externallyVisible.includes(sensitive), false);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.logs, []);
  assert.deepEqual(consoleCalls, []);
});

test("production Shop route handles only its exact path and rejects unsupported methods", async () => {
  const f = fixture();
  const post = await invoke(f.server, { method: "POST", url: SHOP_PATH });
  assert.equal(post.status, 405);
  assert.equal(post.headers.Allow, "GET");
  assert.equal((await invoke(f.server, { url: `${SHOP_PATH}-extra` })).status, 404);
  assert.equal((await invoke(f.server, { url: `/oauth/tiktok/callback?auth_code=${CODE_CANARY}` })).status, 404);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.logs, []);
});

test("production Ads health contract and telemetry/LINE dry-run status stay unchanged", async () => {
  const f = fixture();
  const result = await invoke(f.server, { url: "/health" });
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.body), {
    ok: true, service: "live-gmv-max-guard", controlPlaneOnly: true, telemetryAlertsEnabled: true,
    executionEnabled: false, monitorEnabled: false,
    lineControls: { enabled: true, configuredClients: 1, writeMode: "dry-run", autoBoostClients: 1, autoBoostWriteMode: "dry-run" },
    adapters: {
      line: { enabled: true, source: "messaging-api" }, tiktok: { enabled: false, source: null },
      chromeTelemetry: { enabled: true, source: "signed-http-p256", status: "degraded", configuredClients: 1,
        reportingClients: 1, freshClients: 0, staleClients: 1, latestObservedAt: "2026-07-21T05:31:50.634Z" }
    }
  });
  assert.deepEqual(f.calls, [["telemetry-read"]]);
  assert.deepEqual(f.logs, []);
});

test("existing Ads admin authorization still rejects uncredentialed requests", async () => {
  const f = fixture();
  const result = await invoke(f.server, { method: "POST", url: "/admin/poll" });
  assert.equal(result.status, 401);
  assert.deepEqual(JSON.parse(result.body), { ok: false, error: "unauthorized" });
  assert.deepEqual(f.calls, []);
});

test("existing LINE signature validation and valid event dispatch stay unchanged", async () => {
  const f = fixture();
  const body = JSON.stringify({ events: [{ type: "offline-fixture-event" }] });
  const invalid = await invoke(f.server, { method: "POST", url: "/webhooks/line", body,
    headers: { "x-line-signature": "invalid" } });
  assert.equal(invalid.status, 401);
  assert.deepEqual(f.calls, []);
  const signature = crypto.createHmac("sha256", CHANNEL_SECRET).update(body).digest("base64");
  const valid = await invoke(f.server, { method: "POST", url: "/webhooks/line", body,
    headers: { "x-line-signature": signature } });
  assert.equal(valid.status, 200);
  assert.deepEqual(JSON.parse(valid.body), { ok: true, results: [{ status: "PROCESSED" }] });
  assert.deepEqual(f.calls, [["line", [{ type: "offline-fixture-event" }]]]);
  assert.deepEqual(f.logs, []);
});
