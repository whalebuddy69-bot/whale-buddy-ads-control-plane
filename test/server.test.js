import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  adminAuthorized,
  assertRuntimeCompatibility,
  createHttpServer,
  lineWebhookHttpStatus,
  requiredEnvironmentVariables,
  resolveRuntimeMode,
  resolveTelemetryOptions
} from "../src/server.js";

const adminKey = "x".repeat(43);

async function invoke(server, { method = "GET", url = "/", headers = {}, body = "" } = {}) {
  return new Promise((resolve) => {
    const request = {
      method,
      url,
      headers,
      socket: { remoteAddress: "127.0.0.1" },
      async *[Symbol.asyncIterator]() {
        if (body !== "") yield Buffer.from(body);
      }
    };
    const result = { status: null, headers: null, body: null };
    const response = {
      writeHead(status, responseHeaders) {
        result.status = status;
        result.headers = responseHeaders;
      },
      end(value) {
        result.body = value == null || value === "" ? null : JSON.parse(String(value));
        resolve(result);
      }
    };
    server.emit("request", request, response);
  });
}

test("admin routes require the bearer credential", () => {
  const expected = "x".repeat(43);
  assert.equal(adminAuthorized({ headers: {} }, expected), false);
  assert.equal(adminAuthorized({ headers: { authorization: "Bearer wrong" } }, expected), false);
  assert.equal(adminAuthorized({ headers: { authorization: `Bearer ${expected}` } }, expected), true);
});

test("LINE failures and active leases return 500 so LINE redelivers", () => {
  assert.equal(lineWebhookHttpStatus([{ status: "FAILED" }]), 500);
  assert.equal(lineWebhookHttpStatus([{ status: "IN_PROGRESS" }]), 500);
  assert.equal(lineWebhookHttpStatus([{ status: "PROCESSED" }, { status: "DUPLICATE" }]), 200);
  assert.equal(lineWebhookHttpStatus([]), 200);
});

test("control-plane mode overrides mutation flags and does not require TikTok credentials", () => {
  const runtime = resolveRuntimeMode({
    CONTROL_PLANE_ONLY: "true",
    EXECUTION_ENABLED: "true",
    MONITOR_ENABLED: "true",
    STARTUP_VALIDATION_ENABLED: "true"
  });

  assert.equal(runtime.controlPlaneOnly, true);
  assert.equal(runtime.executionEnabled, false);
  assert.equal(runtime.monitorEnabled, false);
  assert.equal(runtime.startupValidationEnabled, false);
  assert.equal(runtime.adapters.line.enabled, true);
  assert.equal(runtime.adapters.tiktok.enabled, false);
  assert.deepEqual(runtime.adapters.chromeTelemetry, {
    enabled: false,
    source: null,
    status: "disabled"
  });
  assert.deepEqual(requiredEnvironmentVariables(runtime), [
    "LINE_CHANNEL_SECRET",
    "LINE_CHANNEL_ACCESS_TOKEN",
    "ADMIN_API_KEY"
  ]);

  const fullRuntime = resolveRuntimeMode({});
  assert.equal(requiredEnvironmentVariables(fullRuntime).includes("TIKTOK_ACCESS_TOKEN"), true);

  const telemetryRuntime = resolveRuntimeMode({
    CONTROL_PLANE_ONLY: "true",
    CHROME_TELEMETRY_ENABLED: "true"
  });
  assert.deepEqual(telemetryRuntime.adapters.chromeTelemetry, {
    enabled: true,
    source: "signed-http-p256",
    status: "waiting-for-snapshot"
  });
  assert.equal(requiredEnvironmentVariables(telemetryRuntime).includes("CHROME_TELEMETRY_SHARED_SECRET"), false);
  assert.deepEqual(resolveTelemetryOptions({
    CHROME_TELEMETRY_MAX_CLOCK_SKEW_SECONDS: "180"
  }), { maxClockSkewSeconds: 180 });
  assert.throws(
    () => resolveTelemetryOptions({ CHROME_TELEMETRY_MAX_CLOCK_SKEW_SECONDS: "10" }),
    /between 30 and 900/
  );
});

test("chrome-ui clients cannot start a runtime monitor before that adapter exists", () => {
  const config = { clients: [{ id: "pilot", telemetry: {
    source: "chrome-ui",
    browserProfile: "Whalebuddy Ads",
    tabGroup: "Ppan"
  } }] };
  assert.doesNotThrow(() => assertRuntimeCompatibility(
    config,
    resolveRuntimeMode({ CONTROL_PLANE_ONLY: "true" })
  ));
  assert.throws(
    () => assertRuntimeCompatibility(config, resolveRuntimeMode({ CONTROL_PLANE_ONLY: "false" })),
    /cannot drive TikTok runtime monitoring/
  );
});

test("control-plane HTTP keeps health, LINE webhook, and pairing available", async () => {
  const channelSecret = "line-secret";
  const calls = { events: 0, pairing: 0, poll: 0, manual: 0 };
  const service = {
    executionEnabled: false,
    async handleLineEvents(events) {
      calls.events += 1;
      assert.equal(events[0].type, "message");
      return [{ status: "PROCESSED" }];
    },
    createLinePairing({ clientId, ttlMinutes }) {
      calls.pairing += 1;
      assert.equal(clientId, "pilot");
      assert.equal(ttlMinutes, 10);
      return {
        clientId,
        command: "จับคู่ pilot one-time-code",
        expiresAt: "2026-07-19T12:00:00.000Z"
      };
    },
    async pollOnce() { calls.poll += 1; return []; },
    async createManualRequest() { calls.manual += 1; return {}; }
  };
  const store = {
    appendAuditEvent() {
      throw new Error("control-plane route must not reach TikTok audit path");
    }
  };
  const runtime = resolveRuntimeMode({ CONTROL_PLANE_ONLY: "true" });
  const server = createHttpServer({
    service,
    store,
    channelSecret,
    adminApiKey: adminKey,
    runtime,
    logger: { error() {} }
  });
  const healthResponse = await invoke(server, { url: "/health" });
  assert.equal(healthResponse.status, 200);
  const health = healthResponse.body;
  assert.equal(health.controlPlaneOnly, true);
  assert.equal(health.executionEnabled, false);
  assert.equal(health.monitorEnabled, false);
  assert.equal(health.adapters.tiktok.enabled, false);
  assert.equal(health.adapters.chromeTelemetry.status, "disabled");

  const body = JSON.stringify({ events: [{ type: "message" }] });
  const signature = crypto.createHmac("sha256", channelSecret).update(body).digest("base64");
  const webhookResponse = await invoke(server, {
    method: "POST",
    url: "/webhooks/line",
    headers: { "content-type": "application/json", "x-line-signature": signature },
    body
  });
  assert.equal(webhookResponse.status, 200);
  assert.equal(calls.events, 1);

  const pairingResponse = await invoke(server, {
    method: "POST",
    url: "/admin/line-pairings",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminKey}` },
    body: JSON.stringify({ clientId: "pilot" })
  });
  assert.equal(pairingResponse.status, 201);
  assert.equal(pairingResponse.body.command, "จับคู่ pilot one-time-code");
  assert.equal(calls.pairing, 1);
});

test("control-plane HTTP refuses poll and manual requests before touching adapters", async () => {
  const calls = { poll: 0, manual: 0 };
  const service = {
    executionEnabled: false,
    async pollOnce() { calls.poll += 1; return []; },
    async createManualRequest() { calls.manual += 1; return {}; }
  };
  const store = {
    appendAuditEvent() {
      throw new Error("must not append poll/request audit in unavailable mode");
    }
  };
  const server = createHttpServer({
    service,
    store,
    channelSecret: "line-secret",
    adminApiKey: adminKey,
    runtime: resolveRuntimeMode({ CONTROL_PLANE_ONLY: "true" }),
    logger: { error() {} }
  });
  const headers = { "content-type": "application/json", authorization: `Bearer ${adminKey}` };

  const pollResponse = await invoke(server, { method: "POST", url: "/admin/poll", headers });
  assert.equal(pollResponse.status, 503);
  assert.equal(pollResponse.body.error, "CONTROL_PLANE_ONLY");

  const requestResponse = await invoke(server, {
    method: "POST",
    url: "/admin/requests",
    headers,
    body: JSON.stringify({ advertiserId: "adv", campaignId: "cmp", proposedBudget: 1200 })
  });
  assert.equal(requestResponse.status, 503);
  assert.equal(requestResponse.body.error, "CONTROL_PLANE_ONLY");
  assert.deepEqual(calls, { poll: 0, manual: 0 });
});
