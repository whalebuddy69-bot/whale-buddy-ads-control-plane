import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { SqliteStore } from "../src/store.js";

test("campaign shortcuts keep immutable revisions and return only the latest", () => {
  const store = new SqliteStore();
  try {
    const first = store.saveCampaignShortcut({
      clientId: "punpan_020",
      shortcutName: "main",
      campaignNameTemplate: "{date} {start}:00",
      dailyBudgetMinor: 300_000,
      targetRoiMilli: 3500,
      topUpThresholdBps: 8000,
      lineUserId: "U-owner",
      createdAt: "2026-07-20T10:00:00.000Z"
    });
    const second = store.saveCampaignShortcut({
      clientId: "punpan_020",
      shortcutName: "main",
      campaignNameTemplate: "{date} Live",
      dailyBudgetMinor: 400_000,
      targetRoiMilli: 4000,
      topUpThresholdBps: 8500,
      lineUserId: "U-owner",
      createdAt: "2026-07-20T10:01:00.000Z"
    });
    assert.equal(first.revision, 1);
    assert.equal(second.revision, 2);
    assert.equal(store.getCampaignShortcut({
      clientId: "punpan_020",
      shortcutName: "main"
    }).dailyBudgetMinor, 400_000);
    assert.deepEqual(
      store.listCampaignShortcuts({ clientId: "punpan_020" }).map((item) => item.revision),
      [2]
    );
  } finally {
    store.close();
  }
});

test("scheduled report occurrence advances only after a successful delivery", () => {
  const store = new SqliteStore();
  try {
    const subscription = store.setReportSubscription({
      clientId: "punpan_020",
      lineUserId: "U-owner",
      intervalMinutes: 60,
      now: "2026-07-20T10:00:00.000Z"
    });
    assert.equal(subscription.nextDueAt, "2026-07-20T11:00:00.000Z");
    const firstClaim = store.claimDueReportSubscriptions({
      now: "2026-07-20T11:00:00.000Z"
    });
    assert.equal(firstClaim.length, 1);
    assert.equal(firstClaim[0].occurrenceAt, "2026-07-20T11:00:00.000Z");
    assert.equal(store.claimDueReportSubscriptions({
      now: "2026-07-20T11:00:01.000Z"
    }).length, 1);

    store.completeReportOccurrence({
      clientId: "punpan_020",
      lineUserId: "U-owner",
      occurrenceAt: firstClaim[0].occurrenceAt,
      now: "2026-07-20T11:00:02.000Z"
    });
    assert.equal(store.claimDueReportSubscriptions({
      now: "2026-07-20T11:00:03.000Z"
    }).length, 0);
    assert.equal(store.getReportSubscription({
      clientId: "punpan_020",
      lineUserId: "U-owner"
    }).nextDueAt, "2026-07-20T12:00:00.000Z");
  } finally {
    store.close();
  }
});

test("campaign controls are versioned, expiring, and single-use", () => {
  const store = new SqliteStore();
  try {
    const request = store.createCampaignControlRequest({
      id: "ca_12345678-1234-1234-1234-123456789abc",
      clientId: "punpan_020",
      action: "PAUSE",
      requestedByLineUserId: "U-owner",
      createdAt: "2026-07-20T10:00:00.000Z",
      expiresAt: "2026-07-20T10:15:00.000Z",
      data: { dryRun: true, desired: { campaignStatus: "DISABLE" } }
    });
    assert.equal(request.state, "PENDING_CONFIRMATION");
    const confirmed = store.transitionCampaignControlRequest({
      id: request.id,
      version: 1,
      lineUserId: "U-owner",
      outcome: "confirm",
      now: "2026-07-20T10:01:00.000Z"
    });
    assert.equal(confirmed.state, "CONFIRMED_DRY_RUN");
    assert.equal(confirmed.version, 2);
    assert.throws(() => store.transitionCampaignControlRequest({
      id: request.id,
      version: 1,
      lineUserId: "U-owner",
      outcome: "confirm",
      now: "2026-07-20T10:02:00.000Z"
    }), /CONFIRMED_DRY_RUN/);
  } finally {
    store.close();
  }
});

test("coupon confirmation atomically creates one deterministic schedule and replays safely", () => {
  const store = new SqliteStore();
  try {
    const request = store.createCampaignControlRequest({
      id: "ca_coupon-atomic",
      clientId: "punpan_020",
      action: "SCHEDULE_COUPON_BOOST",
      requestedByLineUserId: "U-owner",
      createdAt: "2026-07-20T10:00:00.000Z",
      expiresAt: "2026-07-20T10:15:00.000Z",
      data: {
        dryRun: true,
        desired: {
          eventAt: "2026-07-20T14:00:00.000Z",
          notifyAt: "2026-07-20T13:30:00.000Z",
          dailyBudgetMinor: 500_000
        }
      }
    });

    const first = store.transitionCouponBoostControlRequest({
      id: request.id,
      version: request.version,
      lineUserId: "U-owner",
      outcome: "confirm",
      now: "2026-07-20T10:01:00.000Z"
    });
    assert.equal(first.request.state, "CONFIRMED_DRY_RUN");
    assert.equal(first.request.version, 2);
    assert.equal(first.schedule.id, `cs_${request.id}`);
    assert.equal(first.schedule.controlRequestId, request.id);
    assert.equal(first.schedule.budgetMinor, 500_000);

    const replay = store.transitionCouponBoostControlRequest({
      id: request.id,
      version: request.version,
      lineUserId: "U-owner",
      outcome: "confirm",
      now: "2026-07-20T10:02:00.000Z"
    });
    assert.deepEqual(replay, first);
    assert.equal(
      store.listAuditEvents({ eventType: "COUPON_SCHEDULE_CREATED" }).length,
      1
    );
    assert.throws(() => store.transitionCouponBoostControlRequest({
      id: request.id,
      version: request.version,
      lineUserId: "U-owner",
      outcome: "reject",
      now: "2026-07-20T10:03:00.000Z"
    }), /CONFIRMED_DRY_RUN/);
  } finally {
    store.close();
  }
});

test("coupon rejection and expiry are terminal, idempotent, and never create schedules", () => {
  const store = new SqliteStore();
  try {
    const rejected = store.createCampaignControlRequest({
      id: "ca_coupon-rejected",
      clientId: "punpan_020",
      action: "SCHEDULE_COUPON_BOOST",
      requestedByLineUserId: "U-owner",
      createdAt: "2026-07-20T10:00:00.000Z",
      expiresAt: "2026-07-20T10:15:00.000Z",
      data: {
        desired: {
          eventAt: "2026-07-20T14:00:00.000Z",
          notifyAt: "2026-07-20T13:30:00.000Z",
          dailyBudgetMinor: 500_000
        }
      }
    });
    const firstReject = store.transitionCouponBoostControlRequest({
      id: rejected.id,
      version: 1,
      lineUserId: "U-owner",
      outcome: "reject",
      now: "2026-07-20T10:01:00.000Z"
    });
    const replayedReject = store.transitionCouponBoostControlRequest({
      id: rejected.id,
      version: 1,
      lineUserId: "U-owner",
      outcome: "reject",
      now: "2026-07-20T10:02:00.000Z"
    });
    assert.equal(firstReject.request.state, "CANCELLED");
    assert.equal(firstReject.schedule, null);
    assert.deepEqual(replayedReject, firstReject);

    const expiring = store.createCampaignControlRequest({
      id: "ca_coupon-expired",
      clientId: "punpan_020",
      action: "SCHEDULE_COUPON_BOOST",
      requestedByLineUserId: "U-owner",
      createdAt: "2026-07-20T10:00:00.000Z",
      expiresAt: "2026-07-20T10:15:00.000Z",
      data: {
        desired: {
          eventAt: "2026-07-20T14:00:00.000Z",
          notifyAt: "2026-07-20T13:30:00.000Z",
          dailyBudgetMinor: 500_000
        }
      }
    });
    const firstExpired = store.transitionCouponBoostControlRequest({
      id: expiring.id,
      version: 1,
      lineUserId: "U-owner",
      outcome: "confirm",
      now: "2026-07-20T10:15:00.000Z"
    });
    const replayedExpired = store.transitionCouponBoostControlRequest({
      id: expiring.id,
      version: 1,
      lineUserId: "U-owner",
      outcome: "confirm",
      now: "2026-07-20T10:16:00.000Z"
    });
    assert.equal(firstExpired.request.state, "EXPIRED");
    assert.equal(firstExpired.schedule, null);
    assert.deepEqual(replayedExpired, firstExpired);
    assert.throws(() => store.transitionCouponBoostControlRequest({
      id: expiring.id,
      version: 1,
      lineUserId: "U-owner",
      outcome: "reject",
      now: "2026-07-20T10:16:00.000Z"
    }), /EXPIRED/);
  } finally {
    store.close();
  }
});

test("coupon reminders persist and recover a stale processing claim", () => {
  const store = new SqliteStore();
  try {
    const schedule = store.createCouponSchedule({
      clientId: "punpan_020",
      lineUserId: "U-owner",
      eventAt: "2026-07-20T14:00:00.000Z",
      notifyAt: "2026-07-20T13:30:00.000Z",
      budgetMinor: 500_000,
      now: "2026-07-20T12:00:00.000Z"
    });
    assert.equal(store.claimDueCouponSchedules({
      now: "2026-07-20T13:30:00.000Z"
    })[0].status, "PROCESSING");
    assert.equal(store.claimDueCouponSchedules({
      now: "2026-07-20T13:31:59.000Z"
    }).length, 0);
    const reclaimed = store.claimDueCouponSchedules({
      now: "2026-07-20T13:32:01.000Z"
    });
    assert.equal(reclaimed.length, 1);
    assert.equal(reclaimed[0].attemptCount, 2);
    assert.equal(store.finishCouponSchedule({
      id: schedule.id,
      ok: true,
      now: "2026-07-20T13:32:02.000Z"
    }).status, "SENT");
    assert.deepEqual(
      store.listAuditEvents({ limit: 100 })
        .map((event) => event.eventType)
        .filter((eventType) => eventType.startsWith("COUPON_SCHEDULE_")),
      [
        "COUPON_SCHEDULE_CREATED",
        "COUPON_SCHEDULE_CLAIMED",
        "COUPON_SCHEDULE_CLAIMED",
        "COUPON_SCHEDULE_FINISHED"
      ]
    );

    store.createCouponSchedule({
      clientId: "punpan_020",
      lineUserId: "U-owner",
      eventAt: "2026-07-20T16:00:00.000Z",
      notifyAt: "2026-07-20T15:30:00.000Z",
      budgetMinor: 600_000,
      now: "2026-07-20T13:32:03.000Z"
    });
    assert.equal(store.cancelPendingCouponSchedules({
      clientId: "punpan_020",
      lineUserId: "U-owner",
      now: "2026-07-20T13:32:04.000Z"
    }), 1);
    assert.equal(
      store.listAuditEvents({ eventType: "COUPON_SCHEDULE_CANCELLED" }).length,
      1
    );
  } finally {
    store.close();
  }
});

test("coupon control link migrates safely from the intermediate schedule schema", () => {
  const directory = mkdtempSync(join(tmpdir(), "whale-buddy-coupon-migration-"));
  const filename = join(directory, "control-plane.sqlite");
  const intermediate = new DatabaseSync(filename);
  intermediate.exec(`
    CREATE TABLE coupon_schedules (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      line_user_id TEXT NOT NULL,
      event_at TEXT NOT NULL,
      notify_at TEXT NOT NULL,
      budget_minor INTEGER NOT NULL CHECK(budget_minor > 0),
      status TEXT NOT NULL CHECK(status IN (
        'PENDING', 'PROCESSING', 'SENT', 'FAILED', 'CANCELLED'
      )),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_error TEXT
    ) STRICT;
  `);
  intermediate.close();

  const store = new SqliteStore(filename);
  try {
    const request = store.createCampaignControlRequest({
      id: "ca_migrated-coupon",
      clientId: "punpan_020",
      action: "SCHEDULE_COUPON_BOOST",
      requestedByLineUserId: "U-owner",
      createdAt: "2026-07-20T10:00:00.000Z",
      expiresAt: "2026-07-20T10:15:00.000Z",
      data: {
        desired: {
          eventAt: "2026-07-20T14:00:00.000Z",
          notifyAt: "2026-07-20T13:30:00.000Z",
          dailyBudgetMinor: 500_000
        }
      }
    });
    const result = store.transitionCouponBoostControlRequest({
      id: request.id,
      version: 1,
      lineUserId: "U-owner",
      outcome: "confirm",
      now: "2026-07-20T10:01:00.000Z"
    });
    assert.equal(result.schedule.controlRequestId, request.id);
    assert.equal(
      store.getCouponScheduleByControlRequestId(request.id).id,
      result.schedule.id
    );
    const inspection = new DatabaseSync(filename);
    try {
      assert.ok(
        inspection.prepare("PRAGMA foreign_key_list(coupon_schedules)").all()
          .some((foreignKey) => foreignKey.from === "control_request_id"
            && foreignKey.table === "campaign_control_requests"
            && foreignKey.to === "id")
      );
      assert.ok(
        inspection.prepare("PRAGMA index_list(coupon_schedules)").all()
          .some((index) => index.name === "coupon_schedules_control_request_idx"
            && index.unique === 1)
      );
    } finally {
      inspection.close();
    }
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
