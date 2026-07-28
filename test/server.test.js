import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  adminAuthorized,
  assertRuntimeCompatibility,
  createHttpServer,
  deriveTikTokTokenEncryptionKey,
  lineWebhookHttpStatus,
  parseTikTokOAuthAdminLineUserIds,
  requiredEnvironmentVariables,
  resolveRuntimeMode,
  resolveTelemetryOptions,
  runNotificationCycle,
  tiktokOAuthCallbackHttpStatus
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
        if (value == null || value === "") {
          result.body = null;
        } else {
          try {
            result.body = JSON.parse(String(value));
          } catch {
            result.body = String(value);
          }
        }
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

test("TikTok token encryption key requires 32 input bytes before one stable derivation", () => {
  assert.throws(
    () => deriveTikTokTokenEncryptionKey("x".repeat(31)),
    /at least 32 bytes/
  );
  assert.throws(
    () => deriveTikTokTokenEncryptionKey(null),
    /at least 32 bytes/
  );

  const source = "0123456789abcdef".repeat(2);
  const key = deriveTikTokTokenEncryptionKey(source);
  assert.equal(Buffer.isBuffer(key), true);
  assert.equal(key.byteLength, 32);
  assert.deepEqual(
    key,
    crypto.createHash("sha256").update(source, "utf8").digest()
  );
});

test("TikTok OAuth admins require explicit unique LINE user IDs", () => {
  const first = `U${"a".repeat(32)}`;
  const second = `U${"b".repeat(32)}`;
  assert.deepEqual(
    parseTikTokOAuthAdminLineUserIds(`${first}, ${second}`),
    [first, second]
  );
  assert.throws(() => parseTikTokOAuthAdminLineUserIds("U-owner"), /LINE user IDs/);
  assert.throws(() => parseTikTokOAuthAdminLineUserIds(`${first},${first}`), /unique/);
});

test("control-plane mode overrides mutation flags and does not require TikTok credentials", () => {
  const runtime = resolveRuntimeMode({
    CONTROL_PLANE_ONLY: "true",
    EXECUTION_ENABLED: "true",
    MONITOR_ENABLED: "true",
    STARTUP_VALIDATION_ENABLED: "true"
  });

  assert.equal(runtime.controlPlaneOnly, true);
  assert.equal(runtime.telemetryAlertsEnabled, false);
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

  const apiControlRuntime = resolveRuntimeMode({
    CONTROL_PLANE_ONLY: "true",
    TIKTOK_API_CONTROL_ENABLED: "true"
  });
  assert.equal(apiControlRuntime.executionEnabled, false);
  assert.deepEqual(apiControlRuntime.adapters.tiktok, {
    enabled: true,
    source: "business-api",
    writeMode: "read-only"
  });
  assert.deepEqual(
    requiredEnvironmentVariables(apiControlRuntime).slice(-6),
    [
      "TIKTOK_APP_ID",
      "TIKTOK_APP_SECRET",
      "TIKTOK_OAUTH_REDIRECT_URI",
      "TIKTOK_OAUTH_STATE_SECRET",
      "TIKTOK_TOKEN_ENCRYPTION_KEY",
      "TIKTOK_OAUTH_ADMIN_LINE_USER_IDS"
    ]
  );

  const telemetryRuntime = resolveRuntimeMode({
    CONTROL_PLANE_ONLY: "true",
    CHROME_TELEMETRY_ENABLED: "true",
    CHROME_TELEMETRY_ALERTS_ENABLED: "true"
  });
  assert.equal(telemetryRuntime.telemetryAlertsEnabled, true);
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
  assert.throws(
    () => resolveRuntimeMode({
      CONTROL_PLANE_ONLY: "true",
      CHROME_TELEMETRY_ALERTS_ENABLED: "true"
    }),
    /requires CHROME_TELEMETRY_ENABLED=true/
  );
  assert.throws(
    () => resolveRuntimeMode({
      CONTROL_PLANE_ONLY: "false",
      CHROME_TELEMETRY_ENABLED: "true",
      CHROME_TELEMETRY_ALERTS_ENABLED: "true"
    }),
    /requires CONTROL_PLANE_ONLY=true/
  );
});

test("notification cycle evaluates latest telemetry only when the opt-in flag is enabled", async () => {
  const calls = [];
  const service = {
    async processLatestTelemetryDryRunAlerts(options) { calls.push(["telemetry", options]); },
    async recoverLineWebhookEvents(options) { calls.push(["recovery", options]); },
    async retryPendingAlerts(options) { calls.push(["alerts", options]); },
    async retryPendingResults(options) { calls.push(["results", options]); }
  };
  await runNotificationCycle({ service, telemetryAlertsEnabled: false });
  assert.deepEqual(calls.map(([name]) => name), ["recovery", "alerts", "results"]);
  calls.length = 0;
  await runNotificationCycle({ service, telemetryAlertsEnabled: true });
  assert.deepEqual(calls.map(([name]) => name), ["telemetry", "recovery", "alerts", "results"]);
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

test("TikTok OAuth callback stores authorization without exposing credentials", async () => {
  const calls = [];
  const tiktokApiControl = {
    async completeAuthorization(input) {
      calls.push(input);
      return {
        credentialRef: "ttcred_internal",
        advertiserIds: ["7666005333864644624"],
        notificationSent: true
      };
    }
  };
  const server = createHttpServer({
    service: { executionEnabled: false },
    store: {},
    tiktokApiControl,
    channelSecret: "line-secret",
    adminApiKey: adminKey,
    runtime: resolveRuntimeMode({
      CONTROL_PLANE_ONLY: "true",
      TIKTOK_API_CONTROL_ENABLED: "true"
    }),
    logger: { error() {} }
  });
  const response = await invoke(server, {
    url: "/oauth/tiktok/callback?auth_code=one-time-code&state=signed-state"
  });
  assert.equal(response.status, 200);
  assert.match(response.body, /เชื่อม TikTok API สำเร็จ/);
  assert.doesNotMatch(response.body, /ttcred_internal|one-time-code|signed-state/);
  assert.deepEqual(calls, [{ authCode: "one-time-code", state: "signed-state" }]);
});

test("TikTok OAuth callback maps every failure to a non-2xx safe status", async () => {
  const cases = [
    ["TIKTOK_OAUTH_INVALID_STATE", undefined, 400],
    ["TIKTOK_OAUTH_STATE_EXPIRED", undefined, 400],
    ["TIKTOK_OAUTH_STATE_ALREADY_CONSUMED", undefined, 409],
    ["TIKTOK_OAUTH_TIMEOUT", undefined, 503],
    ["TIKTOK_OAUTH_TRANSPORT_ERROR", undefined, 503],
    ["TIKTOK_OAUTH_HTTP_ERROR", 503, 503],
    ["TIKTOK_OAUTH_HTTP_ERROR", 401, 502],
    ["TIKTOK_OAUTH_API_ERROR", 200, 502],
    ["GENERIC_CALLBACK_FAILURE", 200, 500]
  ];

  for (const [code, upstreamStatus, expectedStatus] of cases) {
    const error = Object.assign(new Error(`secret-sentinel-${code}`), {
      code,
      status: upstreamStatus
    });
    assert.equal(tiktokOAuthCallbackHttpStatus(error), expectedStatus);

    const server = createHttpServer({
      service: { executionEnabled: false },
      store: {},
      tiktokApiControl: {
        async completeAuthorization() {
          throw error;
        }
      },
      channelSecret: "line-secret",
      adminApiKey: adminKey,
      runtime: resolveRuntimeMode({
        CONTROL_PLANE_ONLY: "true",
        TIKTOK_API_CONTROL_ENABLED: "true"
      }),
      logger: { error() {} }
    });
    const response = await invoke(server, {
      url: "/oauth/tiktok/callback?auth_code=one-time-code&state=signed-state"
    });
    assert.equal(response.status, expectedStatus, code);
    assert.equal(response.status >= 200 && response.status < 300, false, code);
    assert.match(response.headers["content-type"], /^text\/html/);
    assert.doesNotMatch(response.body, /secret-sentinel|one-time-code|signed-state/);
  }
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
