import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { validateConfig } from "../src/config.js";
import {
  TELEMETRY_ROI_SCALE,
  TELEMETRY_UI_SCHEMA_FINGERPRINT_V1,
  TELEMETRY_UI_SCHEMA_FINGERPRINT_V2,
  TelemetryError,
  telemetrySigningMessage,
  telemetryUiCampaignRef,
  validateTelemetryEnrollmentRequest,
  validateTelemetrySnapshot,
  verifyTelemetryRequest
} from "../src/telemetry.js";

const now = new Date("2026-07-20T12:00:00.000Z");

function config() {
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
      campaignSelector: {
        kind: "active-live-gmv-max",
        currency: "THB",
        expectedTikTokAccountId: "7285935731820920833",
        requireExactlyOne: true
      },
      liveWindow: { start: "06:00", end: "23:00" },
      budgetIncrease: { presetPercent: 20, allowManualTarget: true },
      budgetPolicy: { maxDailyBudget: 6000, effectiveFrom: "2026-07-19", revision: 1 }
    }]
  });
}

function credential(publicKeyJwk = {}) {
  return {
    credentialId: "tc_12345678-1234-1234-1234-123456789abc",
    clientId: "punpan_020",
    installationId: "install_1234567890",
    publicKeyJwk,
    browserProfile: "Whalebuddy Ads",
    tabGroup: "Ppan",
    businessCenterId: "7627179356976201745",
    sellerMode: "withoutShop",
    pageType: "live",
    createdAt: "2026-07-20T11:00:00.000Z",
    revokedAt: null
  };
}

function snapshot(overrides = {}) {
  const value = {
    schemaVersion: 1,
    uiSchemaFingerprint: TELEMETRY_UI_SCHEMA_FINGERPRINT_V1,
    snapshotId: "ts_12345678-1234-1234-1234-123456789abc",
    clientId: "punpan_020",
    advertiserId: "7646832328389263378",
    businessCenterId: "7627179356976201745",
    sellerMode: "withoutShop",
    pageType: "live",
    tiktokAccountId: "7285935731820920833",
    campaignId: null,
    campaignRef: telemetryUiCampaignRef({
      advertiserId: "7646832328389263378",
      campaignName: "2026-07-20 06:00:00"
    }),
    campaignName: "2026-07-20 06:00:00",
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

function snapshotV2(overrides = {}) {
  return snapshot({
    schemaVersion: 2,
    uiSchemaFingerprint: TELEMETRY_UI_SCHEMA_FINGERPRINT_V2,
    grossRevenueMinor: 120_000,
    grossRoiMilli: 3_690,
    netRevenueMinor: 110_000,
    netRoiMilli: 3_660,
    gmvMinor: 120_000,
    ...overrides
  });
}

function assertTelemetryCode(code) {
  return (error) => error instanceof TelemetryError && error.code === code;
}

test("telemetry snapshot is exact, account-bound, integer-safe, and read-only data", () => {
  const value = validateTelemetrySnapshot(snapshot(), {
    config: config(),
    credential: credential(),
    now
  });
  assert.equal(value.dailyBudgetMinor, 40_000);
  assert.equal(value.totalBudgetMinor, 40_000);
  assert.equal(value.costMinor, 0);
  assert.equal(value.netCostMinor, 0);
  assert.deepEqual(value.policy, {
    maxDailyBudgetMinor: 600_000,
    overDailyBudgetCap: false
  });
  assert.equal("proposedBudget" in value, false);
  assert.equal("approved" in value, false);
  assert(Object.isFrozen(value));
  assert(Object.isFrozen(value.source));
});

test("telemetry v2 validates exact revenue, ROI, and GMV observations", () => {
  const value = validateTelemetrySnapshot(snapshotV2(), {
    config: config(),
    credential: credential(),
    now
  });
  assert.equal(TELEMETRY_ROI_SCALE, 1_000);
  assert.equal(value.schemaVersion, 2);
  assert.equal(value.uiSchemaFingerprint, TELEMETRY_UI_SCHEMA_FINGERPRINT_V2);
  assert.equal(value.grossRevenueMinor, 120_000);
  assert.equal(value.grossRoiMilli, 3_690);
  assert.equal(value.netRevenueMinor, 110_000);
  assert.equal(value.netRoiMilli, 3_660);
  assert.equal(value.gmvMinor, 120_000);
  assert(Object.isFrozen(value));
});

test("telemetry v2 preserves known no-data metrics as null", () => {
  const value = validateTelemetrySnapshot(snapshotV2({
    grossRevenueMinor: null,
    grossRoiMilli: null,
    netRevenueMinor: null,
    netRoiMilli: null,
    gmvMinor: null
  }), {
    config: config(),
    credential: credential(),
    now
  });
  for (const field of [
    "grossRevenueMinor",
    "grossRoiMilli",
    "netRevenueMinor",
    "netRoiMilli",
    "gmvMinor"
  ]) {
    assert.equal(value[field], null);
  }
});

test("telemetry v1 remains supported and cannot smuggle v2 fields", () => {
  const value = validateTelemetrySnapshot(snapshot(), {
    config: config(), credential: credential(), now
  });
  assert.equal(value.schemaVersion, 1);
  assert.equal("grossRevenueMinor" in value, false);
  assert.throws(
    () => validateTelemetrySnapshot(snapshot({ grossRevenueMinor: null }), {
      config: config(), credential: credential(), now
    }),
    assertTelemetryCode("INVALID_TELEMETRY_SNAPSHOT")
  );
});

test("telemetry fails closed on parser drift and every routing identity", () => {
  for (const [overrides, code] of [
    [{ uiSchemaFingerprint: "0".repeat(64) }, "TELEMETRY_UI_SCHEMA_MISMATCH"],
    [{ clientId: "another-client" }, "TELEMETRY_BINDING_MISMATCH"],
    [{ advertiserId: "7646832328389263379" }, "TELEMETRY_BINDING_MISMATCH"],
    [{ businessCenterId: "7627179356976201746" }, "TELEMETRY_BINDING_MISMATCH"],
    [{ sellerMode: "shop-123" }, "TELEMETRY_BINDING_MISMATCH"],
    [{ pageType: "product" }, "TELEMETRY_BINDING_MISMATCH"],
    [{ tiktokAccountId: "7285935731820920834" }, "TELEMETRY_BINDING_MISMATCH"],
    [{ campaignId: "1871072292203826" }, "TELEMETRY_BINDING_MISMATCH"],
    [{ campaignRef: "ui:" + "0".repeat(64) }, "TELEMETRY_BINDING_MISMATCH"],
    [{ campaignType: "GMV_MAX" }, "TELEMETRY_BINDING_MISMATCH"],
    [{ campaignStatus: "INACTIVE" }, "TELEMETRY_BINDING_MISMATCH"],
    [{ currency: "USD" }, "TELEMETRY_BINDING_MISMATCH"],
    [{ source: { browserProfile: "Work", tabGroup: "Ppan" } }, "TELEMETRY_BINDING_MISMATCH"],
    [{ source: { browserProfile: "Whalebuddy Ads", tabGroup: "Other" } }, "TELEMETRY_BINDING_MISMATCH"]
  ]) {
    assert.throws(
      () => validateTelemetrySnapshot(snapshot(overrides), {
        config: config(),
        credential: credential(),
        now
      }),
      assertTelemetryCode(code)
    );
  }
});

test("telemetry validates all four UI money observations and observation time", () => {
  for (const [field, value] of [
    ["dailyBudgetMinor", 400.5],
    ["dailyBudgetMinor", 0],
    ["totalBudgetMinor", -1],
    ["costMinor", Number.NaN],
    ["netCostMinor", -1]
  ]) {
    assert.throws(
      () => validateTelemetrySnapshot(snapshot({ [field]: value }), {
        config: config(), credential: credential(), now
      }),
      assertTelemetryCode("INVALID_TELEMETRY_SNAPSHOT")
    );
  }
  assert.throws(
    () => validateTelemetrySnapshot(snapshot({ observedAt: "2026-07-20T11:40:00.000Z" }), {
      config: config(), credential: credential(), now
    }),
    assertTelemetryCode("TELEMETRY_TIMESTAMP_OUT_OF_RANGE")
  );
  assert.throws(
    () => validateTelemetrySnapshot(snapshot({ observedAt: "2026-07-20T12:02:00.000Z" }), {
      config: config(), credential: credential(), now, maxFutureSkewSeconds: 60
    }),
    assertTelemetryCode("TELEMETRY_TIMESTAMP_OUT_OF_RANGE")
  );
});

test("telemetry v2 rejects malformed or missing reporting metrics", () => {
  for (const [field, value] of [
    ["grossRevenueMinor", -1],
    ["grossRevenueMinor", undefined],
    ["grossRoiMilli", 3.69],
    ["grossRoiMilli", -1],
    ["netRevenueMinor", Number.NaN],
    ["netRoiMilli", "3.66"],
    ["gmvMinor", 1200.5]
  ]) {
    assert.throws(
      () => validateTelemetrySnapshot(snapshotV2({ [field]: value }), {
        config: config(), credential: credential(), now
      }),
      assertTelemetryCode("INVALID_TELEMETRY_SNAPSHOT")
    );
  }
  assert.throws(
    () => validateTelemetrySnapshot(snapshotV2({
      uiSchemaFingerprint: TELEMETRY_UI_SCHEMA_FINGERPRINT_V1
    }), {
      config: config(), credential: credential(), now
    }),
    assertTelemetryCode("TELEMETRY_UI_SCHEMA_MISMATCH")
  );
});

test("extension enrollment accepts only a P-256 public verification key", () => {
  const { publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicKeyJwk = publicKey.export({ format: "jwk" });
  const value = validateTelemetryEnrollmentRequest({
    clientId: "punpan_020",
    enrollmentCode: crypto.randomBytes(32).toString("base64url"),
    installationId: "install_1234567890",
    publicKeyJwk
  });
  assert.equal(value.publicKeyJwk.kty, "EC");
  assert.equal(value.publicKeyJwk.crv, "P-256");
  assert.deepEqual(value.publicKeyJwk.key_ops, ["verify"]);

  assert.throws(() => validateTelemetryEnrollmentRequest({
    ...value,
    publicKeyJwk: { kty: "oct", k: crypto.randomBytes(32).toString("base64url") }
  }), assertTelemetryCode("INVALID_TELEMETRY_PUBLIC_KEY"));
});

test("P-256 request signatures cover credential, timestamp, nonce, and raw body", () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const rawBody = Buffer.from(JSON.stringify(snapshot()));
  const headers = {
    "x-wb-telemetry-credential": credential().credentialId,
    "x-wb-telemetry-timestamp": String(Math.floor(now.getTime() / 1000)),
    "x-wb-telemetry-nonce": crypto.randomBytes(16).toString("base64url")
  };
  const message = telemetrySigningMessage({
    credentialId: headers["x-wb-telemetry-credential"],
    timestamp: headers["x-wb-telemetry-timestamp"],
    nonce: headers["x-wb-telemetry-nonce"],
    rawBody
  });
  headers["x-wb-telemetry-signature"] = `v1=${crypto.sign("sha256", message, {
    key: privateKey,
    dsaEncoding: "ieee-p1363"
  }).toString("base64url")}`;

  assert.equal(verifyTelemetryRequest({
    rawBody,
    headers,
    credential: credential(publicKey.export({ format: "jwk" })),
    now,
    maxClockSkewSeconds: 300
  }).credentialId, credential().credentialId);

  assert.throws(() => verifyTelemetryRequest({
    rawBody: Buffer.from(`${rawBody.toString("utf8")} `),
    headers,
    credential: credential(publicKey.export({ format: "jwk" })),
    now,
    maxClockSkewSeconds: 300
  }), assertTelemetryCode("INVALID_TELEMETRY_AUTH"));

  assert.throws(() => verifyTelemetryRequest({
    rawBody,
    headers: { ...headers, "x-wb-telemetry-timestamp": "1784548200" },
    credential: credential(publicKey.export({ format: "jwk" })),
    now,
    maxClockSkewSeconds: 300
  }), assertTelemetryCode("INVALID_TELEMETRY_AUTH"));
});
