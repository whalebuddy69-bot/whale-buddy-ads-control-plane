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
  TELEMETRY_UI_SCHEMA_FINGERPRINT_V2,
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

test("telemetry schema v2 persists reporting metrics without changing v1 history", () => {
  const store = new SqliteStore();
  const credential = enroll(store);
  try {
    const value = snapshot(
      "ts_44444444-4444-4444-4444-444444444444",
      "2026-07-20T11:59:30.000Z",
      {
        schemaVersion: 2,
        uiSchemaFingerprint: TELEMETRY_UI_SCHEMA_FINGERPRINT_V2,
        grossRevenueMinor: 120_000,
        grossRoiMilli: 3690,
        netRevenueMinor: 110_000,
        netRoiMilli: 3660,
        gmvMinor: 120_000
      }
    );
    store.recordTelemetrySnapshot({
      snapshot: value,
      credentialId: credential.credentialId,
      nonce: "EEEEEEEEEEEEEEEEEEEEEE",
      payloadHash: hash("v2-payload"),
      receivedAt: "2026-07-20T12:00:00.000Z",
      pruneNoncesBefore: "2026-07-20T11:49:00.000Z"
    });
    const stored = store.getLatestTelemetry({ clientId: "punpan_020" });
    assert.equal(stored.schemaVersion, 2);
    assert.equal(stored.grossRevenueMinor, 120_000);
    assert.equal(stored.grossRoiMilli, 3690);
    assert.equal(stored.netRevenueMinor, 110_000);
    assert.equal(stored.netRoiMilli, 3660);
    assert.equal(stored.gmvMinor, 120_000);
  } finally {
    store.close();
  }
});

test("existing telemetry v1 table migrates in place to accept v2 metrics", () => {
  const directory = mkdtempSync(join(tmpdir(), "gmv-max-telemetry-v1-migration-"));
  const filename = join(directory, "telemetry.sqlite");
  const snapshotId = "ts_55555555-5555-5555-5555-555555555555";
  const campaignName = "2026-07-20 06:00:00";
  const campaignRef = telemetryUiCampaignRef({
    advertiserId: "7646832328389263378",
    campaignName
  });
  const legacy = new DatabaseSync(filename);
  try {
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE telemetry_credentials (
        credential_id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        installation_id TEXT NOT NULL,
        public_key_jwk TEXT NOT NULL,
        browser_profile TEXT NOT NULL,
        tab_group TEXT NOT NULL,
        business_center_id TEXT NOT NULL,
        seller_mode TEXT NOT NULL,
        page_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT,
        enrollment_id TEXT NOT NULL
      ) STRICT;
      CREATE TABLE telemetry_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        credential_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        advertiser_id TEXT NOT NULL,
        business_center_id TEXT NOT NULL,
        seller_mode TEXT NOT NULL,
        page_type TEXT NOT NULL,
        tiktok_account_id TEXT NOT NULL,
        campaign_id TEXT,
        campaign_ref TEXT NOT NULL,
        campaign_name TEXT NOT NULL,
        campaign_type TEXT NOT NULL CHECK(campaign_type = 'LIVE_GMV_MAX'),
        campaign_status TEXT NOT NULL CHECK(campaign_status = 'ACTIVE'),
        currency TEXT NOT NULL CHECK(currency = 'THB'),
        schema_version INTEGER NOT NULL CHECK(schema_version = 1),
        ui_schema_fingerprint TEXT NOT NULL,
        daily_budget_minor INTEGER NOT NULL CHECK(daily_budget_minor > 0),
        total_budget_minor INTEGER NOT NULL CHECK(total_budget_minor > 0),
        cost_minor INTEGER NOT NULL CHECK(cost_minor >= 0),
        net_cost_minor INTEGER NOT NULL CHECK(net_cost_minor >= 0),
        policy_cap_minor INTEGER NOT NULL CHECK(policy_cap_minor > 0),
        over_policy_cap INTEGER NOT NULL CHECK(over_policy_cap IN (0, 1)),
        observed_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        source_browser_profile TEXT NOT NULL,
        source_tab_group TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        FOREIGN KEY(credential_id) REFERENCES telemetry_credentials(credential_id)
      ) STRICT;
      CREATE TABLE telemetry_latest (
        client_id TEXT PRIMARY KEY,
        snapshot_id TEXT NOT NULL UNIQUE,
        observed_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        FOREIGN KEY(snapshot_id) REFERENCES telemetry_snapshots(snapshot_id)
      ) STRICT;
      CREATE TABLE telemetry_alert_evaluations (
        snapshot_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        request_id TEXT,
        evaluated_at TEXT NOT NULL,
        details_json TEXT NOT NULL,
        FOREIGN KEY(snapshot_id) REFERENCES telemetry_snapshots(snapshot_id)
      ) STRICT;
    `);
    legacy.prepare(`
      INSERT INTO telemetry_credentials (
        credential_id, client_id, installation_id, public_key_jwk,
        browser_profile, tab_group, business_center_id, seller_mode, page_type,
        created_at, revoked_at, enrollment_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    `).run(
      "tc_55555555-5555-5555-5555-555555555555",
      "punpan_020",
      "install_legacy_123",
      "{}",
      "Whalebuddy Ads",
      "Ppan",
      "7627179356976201745",
      "withoutShop",
      "live",
      "2026-07-20T11:50:00.000Z",
      "te_legacy_123"
    );
    legacy.prepare(`
      INSERT INTO telemetry_snapshots (
        snapshot_id, credential_id, client_id, advertiser_id, business_center_id,
        seller_mode, page_type, tiktok_account_id, campaign_id, campaign_ref,
        campaign_name, campaign_type, campaign_status, currency, schema_version,
        ui_schema_fingerprint, daily_budget_minor, total_budget_minor, cost_minor,
        net_cost_minor, policy_cap_minor, over_policy_cap, observed_at, received_at,
        source_browser_profile, source_tab_group, payload_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'LIVE_GMV_MAX', 'ACTIVE',
                'THB', 1, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
    `).run(
      snapshotId,
      "tc_55555555-5555-5555-5555-555555555555",
      "punpan_020",
      "7646832328389263378",
      "7627179356976201745",
      "withoutShop",
      "live",
      "7285935731820920833",
      campaignRef,
      campaignName,
      TELEMETRY_UI_SCHEMA_FINGERPRINT_V1,
      300_000,
      300_000,
      240_000,
      230_000,
      600_000,
      "2026-07-20T11:59:30.000Z",
      "2026-07-20T12:00:00.000Z",
      "Whalebuddy Ads",
      "Ppan",
      hash("legacy-v1-payload")
    );
    legacy.prepare(`
      INSERT INTO telemetry_latest (client_id, snapshot_id, observed_at, received_at)
      VALUES (?, ?, ?, ?)
    `).run(
      "punpan_020",
      snapshotId,
      "2026-07-20T11:59:30.000Z",
      "2026-07-20T12:00:00.000Z"
    );
    legacy.prepare(`
      INSERT INTO telemetry_alert_evaluations (
        snapshot_id, status, request_id, evaluated_at, details_json
      ) VALUES (?, 'BELOW_THRESHOLD', NULL, ?, ?)
    `).run(
      snapshotId,
      "2026-07-20T12:00:01.000Z",
      JSON.stringify({ utilization: 0.8 })
    );
  } finally {
    legacy.close();
  }

  const migrated = new SqliteStore(filename);
  try {
    const sql = migrated.db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'telemetry_snapshots'
    `).get().sql;
    assert.match(sql, /schema_version IN \(1, 2\)/);
    const columns = migrated.db.prepare("PRAGMA table_info(telemetry_snapshots)").all()
      .map((column) => column.name);
    for (const field of [
      "gross_revenue_minor",
      "gross_roi_milli",
      "net_revenue_minor",
      "net_roi_milli",
      "gmv_minor"
    ]) assert(columns.includes(field));
    const latest = migrated.getLatestTelemetry({ clientId: "punpan_020" });
    assert.equal(latest.snapshotId, snapshotId);
    assert.equal(latest.schemaVersion, 1);
    assert.equal(latest.grossRevenueMinor, null);
    assert.equal(latest.grossRoiMilli, null);
    assert.equal(latest.netRevenueMinor, null);
    assert.equal(latest.netRoiMilli, null);
    assert.equal(latest.gmvMinor, null);
    const evaluation = migrated.getTelemetryAlertEvaluation(snapshotId);
    assert.equal(evaluation.status, "BELOW_THRESHOLD");
    assert.equal(evaluation.details.utilization, 0.8);
    assert.equal(
      migrated.db.prepare("SELECT COUNT(*) AS count FROM telemetry_snapshots").get().count,
      1
    );
    assert.equal(
      migrated.db.prepare("SELECT COUNT(*) AS count FROM telemetry_latest").get().count,
      1
    );
    assert.equal(
      migrated.db.prepare("SELECT COUNT(*) AS count FROM telemetry_alert_evaluations").get().count,
      1
    );
    assert.equal(migrated.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    migrated.close();
  }
});
