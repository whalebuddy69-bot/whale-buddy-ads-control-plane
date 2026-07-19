import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { DomainError } from "../src/domain.js";
import { SqliteStore } from "../src/store.js";
import {
  TELEMETRY_UI_SCHEMA_FINGERPRINT_V1,
  telemetryUiCampaignRef
} from "../src/telemetry.js";

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function assertCode(code) {
  return (error) => error instanceof DomainError && error.code === code;
}

function snapshot(snapshotId, observedAt, overrides = {}) {
  const value = {
    schemaVersion: 1,
    uiSchemaFingerprint: TELEMETRY_UI_SCHEMA_FINGERPRINT_V1,
    snapshotId,
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
    observedAt,
    source: { browserProfile: "Whalebuddy Ads", tabGroup: "Ppan" },
    policy: { maxDailyBudgetMinor: 600_000, overDailyBudgetCap: false }
  };
  return { ...value, ...overrides };
}

function enroll(store, { code = "extension-bootstrap-code", installationId = "install_1234567890" } = {}) {
  const { publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  store.createTelemetryEnrollment({
    clientId: "punpan_020",
    codeHash: hash(code),
    browserProfile: "Whalebuddy Ads",
    tabGroup: "Ppan",
    businessCenterId: "7627179356976201745",
    sellerMode: "withoutShop",
    pageType: "live",
    createdAt: "2026-07-20T11:50:00.000Z",
    expiresAt: "2026-07-20T12:10:00.000Z"
  });
  return store.consumeTelemetryEnrollment({
    clientId: "punpan_020",
    codeHash: hash(code),
    installationId,
    publicKeyJwk: publicKey.export({ format: "jwk" }),
    consumedAt: "2026-07-20T11:51:00.000Z"
  });
}

test("telemetry enrollment stores only a one-time hash and extension public key", () => {
  const store = new SqliteStore();
  const code = "do-not-store-this-bootstrap-code";
  const { publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  try {
    const enrollment = store.createTelemetryEnrollment({
      clientId: "punpan_020",
      codeHash: hash(code),
      browserProfile: "Whalebuddy Ads",
      tabGroup: "Ppan",
      businessCenterId: "7627179356976201745",
      sellerMode: "withoutShop",
      pageType: "live",
      createdAt: "2026-07-20T11:50:00.000Z",
      expiresAt: "2026-07-20T12:10:00.000Z"
    });
    assert.equal("code" in enrollment, false);
    assert.equal("codeHash" in enrollment, false);
    assert.throws(() => store.consumeTelemetryEnrollment({
      clientId: "punpan_020",
      codeHash: hash("wrong-code"),
      installationId: "install_1234567890",
      publicKeyJwk: publicKey.export({ format: "jwk" }),
      consumedAt: "2026-07-20T11:51:00.000Z"
    }), assertCode("TELEMETRY_ENROLLMENT_INVALID"));

    const credential = store.consumeTelemetryEnrollment({
      clientId: "punpan_020",
      codeHash: hash(code),
      installationId: "install_1234567890",
      publicKeyJwk: publicKey.export({ format: "jwk" }),
      consumedAt: "2026-07-20T11:51:00.000Z"
    });
    assert.match(credential.credentialId, /^tc_/);
    assert.equal(credential.clientId, "punpan_020");
    assert.equal(credential.browserProfile, "Whalebuddy Ads");
    assert.equal(credential.publicKeyJwk.d, undefined);
    assert.throws(() => store.consumeTelemetryEnrollment({
      clientId: "punpan_020",
      codeHash: hash(code),
      installationId: "install_1234567890",
      publicKeyJwk: publicKey.export({ format: "jwk" }),
      consumedAt: "2026-07-20T11:52:00.000Z"
    }), assertCode("TELEMETRY_ENROLLMENT_INVALID"));

    const serializedAudit = JSON.stringify(store.listAuditEvents());
    assert.equal(serializedAudit.includes(code), false);
    assert.equal(serializedAudit.includes(hash(code)), false);
    assert.deepEqual(
      store.listAuditEvents().map((event) => event.eventType),
      ["TELEMETRY_ENROLLMENT_CREATED", "TELEMETRY_CREDENTIAL_ENROLLED"]
    );
  } finally {
    store.close();
  }
});

test("verified telemetry persists latest state, audit history, and replay nonces", () => {
  const directory = mkdtempSync(join(tmpdir(), "gmv-max-telemetry-"));
  const filename = join(directory, "telemetry.sqlite");
  const store = new SqliteStore(filename);
  const credential = enroll(store);
  try {
    const newest = snapshot(
      "ts_11111111-1111-1111-1111-111111111111",
      "2026-07-20T11:59:30.000Z"
    );
    const accepted = store.recordTelemetrySnapshot({
      snapshot: newest,
      credentialId: credential.credentialId,
      nonce: "AAAAAAAAAAAAAAAAAAAAAA",
      payloadHash: hash("newest-payload"),
      receivedAt: "2026-07-20T12:00:00.000Z",
      pruneNoncesBefore: "2026-07-20T11:49:00.000Z"
    });
    assert.deepEqual(
      { accepted: accepted.accepted, duplicate: accepted.duplicate, latest: accepted.latest },
      { accepted: true, duplicate: false, latest: true }
    );
    assert.equal(store.getLatestTelemetry({ clientId: "punpan_020" }).snapshotId, newest.snapshotId);
    assert.equal(store.isTelemetrySnapshotCredentialActive(newest.snapshotId), true);
    assert.equal(store.isTelemetrySnapshotCredentialActive("ts_missing-aaaa-aaaa-aaaa-aaaaaaaaaaaa"), null);
    const evaluation = store.recordTelemetryAlertEvaluation({
      snapshotId: newest.snapshotId,
      status: "BELOW_THRESHOLD",
      evaluatedAt: "2026-07-20T12:00:00.000Z",
      details: { utilization: 0 }
    });
    assert.equal(evaluation.status, "BELOW_THRESHOLD");
    assert.equal(store.getTelemetryAlertEvaluation(newest.snapshotId).details.utilization, 0);

    assert.throws(() => store.recordTelemetrySnapshot({
      snapshot: snapshot("ts_22222222-2222-2222-2222-222222222222", "2026-07-20T11:59:40.000Z"),
      credentialId: credential.credentialId,
      nonce: "AAAAAAAAAAAAAAAAAAAAAA",
      payloadHash: hash("replay-payload"),
      receivedAt: "2026-07-20T12:00:01.000Z",
      pruneNoncesBefore: "2026-07-20T11:49:00.000Z"
    }), assertCode("TELEMETRY_REPLAY"));

    const older = store.recordTelemetrySnapshot({
      snapshot: snapshot("ts_33333333-3333-3333-3333-333333333333", "2026-07-20T11:58:00.000Z"),
      credentialId: credential.credentialId,
      nonce: "BBBBBBBBBBBBBBBBBBBBBB",
      payloadHash: hash("older-payload"),
      receivedAt: "2026-07-20T12:00:02.000Z",
      pruneNoncesBefore: "2026-07-20T11:49:00.000Z"
    });
    assert.equal(older.latest, false);
    assert.equal(store.getLatestTelemetry({ clientId: "punpan_020" }).snapshotId, newest.snapshotId);

    const duplicate = store.recordTelemetrySnapshot({
      snapshot: newest,
      credentialId: credential.credentialId,
      nonce: "CCCCCCCCCCCCCCCCCCCCCC",
      payloadHash: hash("newest-payload"),
      receivedAt: "2026-07-20T12:00:03.000Z",
      pruneNoncesBefore: "2026-07-20T11:49:00.000Z"
    });
    assert.equal(duplicate.duplicate, true);
    assert.throws(() => store.recordTelemetrySnapshot({
      snapshot: newest,
      credentialId: credential.credentialId,
      nonce: "DDDDDDDDDDDDDDDDDDDDDD",
      payloadHash: hash("changed-payload"),
      receivedAt: "2026-07-20T12:00:04.000Z",
      pruneNoncesBefore: "2026-07-20T11:49:00.000Z"
    }), assertCode("TELEMETRY_SNAPSHOT_CONFLICT"));

    assert.equal(store.listTelemetrySnapshots({ clientId: "punpan_020" }).length, 2);
    assert.equal(store.listLatestTelemetry().length, 1);
    const telemetryAudits = store.listAuditEvents().filter((event) =>
      event.eventType.startsWith("CHROME_TELEMETRY_")
    );
    assert.deepEqual(telemetryAudits.map((event) => event.eventType), [
      "CHROME_TELEMETRY_ACCEPTED",
      "CHROME_TELEMETRY_OLDER_ACCEPTED"
    ]);

    enroll(store, { code: "replacement-bootstrap-code", installationId: "install_replacement_123" });
    assert.equal(store.isTelemetrySnapshotCredentialActive(newest.snapshotId), false);

    const raw = new DatabaseSync(filename, { readOnly: true });
    try {
      assert.equal(raw.prepare("SELECT COUNT(*) AS count FROM telemetry_nonces").get().count, 3);
      assert.equal(raw.prepare("SELECT COUNT(*) AS count FROM telemetry_latest").get().count, 1);
    } finally {
      raw.close();
    }
  } finally {
    store.close();
  }

  const reopened = new SqliteStore(filename);
  try {
    assert.equal(
      reopened.getLatestTelemetry({ clientId: "punpan_020" }).snapshotId,
      "ts_11111111-1111-1111-1111-111111111111"
    );
  } finally {
    reopened.close();
  }
});
