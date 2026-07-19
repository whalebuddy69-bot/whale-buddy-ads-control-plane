import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { validateConfig } from "../src/config.js";
import { createHttpServer, resolveRuntimeMode } from "../src/server.js";
import { SqliteStore } from "../src/store.js";
import {
  TELEMETRY_UI_SCHEMA_FINGERPRINT_V1,
  telemetrySigningMessage,
  telemetryUiCampaignRef
} from "../src/telemetry.js";

const adminKey = "x".repeat(43);
const now = new Date("2026-07-20T12:00:00.000Z");

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

function pilotConfig() {
  return validateConfig({
    agencyId: "whalebuddy-ads",
    clients: [{
      id: "punpan_020",
      name: "punpan_020",
      lineApproverUserIds: [],
      linePairingEnabled: true,
      advertiserId: "7646832328389263378",
      shopBinding: { mode: "observe-and-pin" },
      telemetry: {
        source: "chrome-ui",
        browserProfile: "Whalebuddy Ads",
        tabGroup: "Ppan",
        businessCenterId: "7627179356976201745",
        sellerMode: "withoutShop",
        pageType: "live",
        schemaVersion: 1,
        maxSnapshotAgeSeconds: 900
      },
      timezone: "Asia/Bangkok",
      liveWindow: { start: "06:00", end: "23:00" },
      warningThreshold: 0.8,
      campaignSelector: {
        kind: "active-live-gmv-max",
        currency: "THB",
        expectedTikTokAccountId: "7285935731820920833",
        requireExactlyOne: true
      },
      budgetIncrease: { presetPercent: 20, allowManualTarget: true },
      budgetPolicy: { maxDailyBudget: 6000, effectiveFrom: "2026-07-19", revision: 1 }
    }]
  });
}

function payload(overrides = {}) {
  const campaignName = "2026-07-20 06:00:00";
  const value = {
    schemaVersion: 1,
    uiSchemaFingerprint: TELEMETRY_UI_SCHEMA_FINGERPRINT_V1,
    snapshotId: "ts_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    clientId: "punpan_020",
    advertiserId: "7646832328389263378",
    businessCenterId: "7627179356976201745",
    sellerMode: "withoutShop",
    pageType: "live",
    tiktokAccountId: "7285935731820920833",
    campaignId: null,
    campaignRef: telemetryUiCampaignRef({
      advertiserId: "7646832328389263378",
      campaignName
    }),
    campaignName,
    campaignType: "LIVE_GMV_MAX",
    campaignStatus: "ACTIVE",
    currency: "THB",
    dailyBudgetMinor: 40_000,
    totalBudgetMinor: 40_000,
    costMinor: 0,
    netCostMinor: 0,
    observedAt: "2026-07-20T11:59:30.000Z",
    source: { browserProfile: "Whalebuddy Ads", tabGroup: "Ppan" }
  };
  return { ...value, ...overrides };
}

function signedHeaders({ credentialId, privateKey, body, nonce = crypto.randomBytes(16).toString("base64url") }) {
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const message = telemetrySigningMessage({
    credentialId,
    timestamp,
    nonce,
    rawBody: Buffer.from(body)
  });
  const signature = crypto.sign("sha256", message, {
    key: privateKey,
    dsaEncoding: "ieee-p1363"
  }).toString("base64url");
  return {
    "content-type": "application/json",
    "x-wb-telemetry-credential": credentialId,
    "x-wb-telemetry-timestamp": timestamp,
    "x-wb-telemetry-nonce": nonce,
    "x-wb-telemetry-signature": `v1=${signature}`
  };
}

test("control-plane enrolls an extension key and ingests read-only signed telemetry", async () => {
  const store = new SqliteStore();
  const calls = { poll: 0, manual: 0 };
  const service = {
    executionEnabled: false,
    async pollOnce() { calls.poll += 1; return []; },
    async createManualRequest() { calls.manual += 1; return {}; }
  };
  const config = pilotConfig();
  const runtime = resolveRuntimeMode({
    CONTROL_PLANE_ONLY: "true",
    CHROME_TELEMETRY_ENABLED: "true",
    EXECUTION_ENABLED: "true",
    MONITOR_ENABLED: "true"
  });
  const server = createHttpServer({
    service,
    store,
    channelSecret: "line-secret",
    adminApiKey: adminKey,
    runtime,
    config,
    telemetryOptions: { maxClockSkewSeconds: 300 },
    clock: () => new Date(now),
    logger: { error() {} }
  });
  try {
    assert.equal(runtime.executionEnabled, false);
    assert.equal(runtime.monitorEnabled, false);
    assert.equal(runtime.adapters.tiktok.enabled, false);
    assert.equal((await invoke(server, { url: "/health" })).body.adapters.chromeTelemetry.status, "waiting-for-snapshot");

    const unauthorizedEnrollment = await invoke(server, {
      method: "POST",
      url: "/admin/telemetry/enrollments",
      body: JSON.stringify({ clientId: "punpan_020" })
    });
    assert.equal(unauthorizedEnrollment.status, 401);

    const enrollment = await invoke(server, {
      method: "POST",
      url: "/admin/telemetry/enrollments",
      headers: { authorization: `Bearer ${adminKey}`, "content-type": "application/json" },
      body: JSON.stringify({ clientId: "punpan_020", ttlMinutes: 10 })
    });
    assert.equal(enrollment.status, 201);
    assert.match(enrollment.body.enrollmentCode, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(enrollment.body.binding, {
      browserProfile: "Whalebuddy Ads",
      tabGroup: "Ppan",
      businessCenterId: "7627179356976201745",
      sellerMode: "withoutShop",
      pageType: "live"
    });

    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const enrolled = await invoke(server, {
      method: "POST",
      url: "/telemetry/chrome/enroll",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientId: "punpan_020",
        enrollmentCode: enrollment.body.enrollmentCode,
        installationId: "extension_install_123",
        publicKeyJwk: publicKey.export({ format: "jwk" })
      })
    });
    assert.equal(enrolled.status, 201);
    assert.match(enrolled.body.credentialId, /^tc_/);

    const body = JSON.stringify(payload());
    const headers = signedHeaders({
      credentialId: enrolled.body.credentialId,
      privateKey,
      body,
      nonce: "EEEEEEEEEEEEEEEEEEEEEE"
    });
    const accepted = await invoke(server, {
      method: "POST",
      url: "/telemetry/chrome/snapshots",
      headers,
      body
    });
    assert.equal(accepted.status, 202);
    assert.equal(accepted.body.latest, true);
    assert.deepEqual(calls, { poll: 0, manual: 0 });
    assert.equal(store.listBudgetRequests().length, 0);

    const replay = await invoke(server, {
      method: "POST",
      url: "/telemetry/chrome/snapshots",
      headers,
      body
    });
    assert.equal(replay.status, 409);
    assert.equal(replay.body.error, "TELEMETRY_REPLAY");

    const wrongAccountBody = JSON.stringify(payload({
      snapshotId: "ts_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      advertiserId: "7646832328389263379"
    }));
    const wrongAccount = await invoke(server, {
      method: "POST",
      url: "/telemetry/chrome/snapshots",
      headers: signedHeaders({
        credentialId: enrolled.body.credentialId,
        privateKey,
        body: wrongAccountBody,
        nonce: "FFFFFFFFFFFFFFFFFFFFFF"
      }),
      body: wrongAccountBody
    });
    assert.equal(wrongAccount.status, 403);
    assert.equal(store.listTelemetrySnapshots().length, 1);

    const health = (await invoke(server, { url: "/health" })).body;
    assert.equal(health.adapters.chromeTelemetry.status, "healthy");
    assert.equal(health.adapters.chromeTelemetry.configuredClients, 1);
    assert.equal(health.adapters.chromeTelemetry.reportingClients, 1);

    const unauthorizedRead = await invoke(server, { url: "/admin/telemetry/latest" });
    assert.equal(unauthorizedRead.status, 401);
    const read = await invoke(server, {
      url: "/admin/telemetry/latest?clientId=punpan_020",
      headers: { authorization: `Bearer ${adminKey}` }
    });
    assert.equal(read.status, 200);
    assert.equal(read.body.snapshots.length, 1);
    assert.equal(read.body.snapshots[0].campaignId, null);
    assert.match(read.body.snapshots[0].campaignRef, /^ui:[0-9a-f]{64}$/);
    assert.equal(read.body.snapshots[0].dailyBudgetMinor, 40_000);
    assert.equal(read.body.snapshots[0].costMinor, 0);
    assert.equal(read.body.snapshots[0].spendRatio, 0);
    assert.deepEqual(calls, { poll: 0, manual: 0 });

    const replacementEnrollment = await invoke(server, {
      method: "POST",
      url: "/admin/telemetry/enrollments",
      headers: { authorization: `Bearer ${adminKey}`, "content-type": "application/json" },
      body: JSON.stringify({ clientId: "punpan_020", ttlMinutes: 10 })
    });
    const replacementKeys = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const replacement = await invoke(server, {
      method: "POST",
      url: "/telemetry/chrome/enroll",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientId: "punpan_020",
        enrollmentCode: replacementEnrollment.body.enrollmentCode,
        installationId: "extension_install_456",
        publicKeyJwk: replacementKeys.publicKey.export({ format: "jwk" })
      })
    });
    assert.equal(replacement.status, 201);
    assert.notEqual(replacement.body.credentialId, enrolled.body.credentialId);
    assert.notEqual(store.getTelemetryCredential(enrolled.body.credentialId).revokedAt, null);

    const retiredBody = JSON.stringify(payload({
      snapshotId: "ts_cccccccc-cccc-cccc-cccc-cccccccccccc"
    }));
    const retiredCollector = await invoke(server, {
      method: "POST",
      url: "/telemetry/chrome/snapshots",
      headers: signedHeaders({
        credentialId: enrolled.body.credentialId,
        privateKey,
        body: retiredBody,
        nonce: "GGGGGGGGGGGGGGGGGGGGGG"
      }),
      body: retiredBody
    });
    assert.equal(retiredCollector.status, 401);
    assert.equal(retiredCollector.body.error, "INVALID_TELEMETRY_AUTH");
    assert.equal(store.listTelemetrySnapshots().length, 1);
  } finally {
    store.close();
  }
});
