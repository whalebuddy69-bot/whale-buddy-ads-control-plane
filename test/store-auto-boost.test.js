import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { SqliteStore } from '../src/store.js';

const baseProfile = Object.freeze({
  clientId: 'punpan_020',
  baseBudgetMinor: 300_000,
  targetBudgetMinor: 330_000,
  policyCapMinor: 600_000,
  boostBps: 1_000,
  leadMinutes: 10,
  originalWindows: [
    { start: '17:00', end: '18:00' },
    { start: '20:00', end: '21:00' },
  ],
  mergedWindows: [
    { startMinute: 1_010, endMinute: 1_080 },
    { startMinute: 1_190, endMinute: 1_260 },
  ],
  ownerLineUserId: 'U-owner',
  executionMode: 'DRY_RUN',
});

function saveProfile(store, overrides = {}) {
  return store.saveAutoBoostProfile({
    ...baseProfile,
    sourceEventId: 'line-profile-1',
    commandSequence: 1,
    now: '2026-07-20T09:00:00.000Z',
    ...overrides,
  });
}

test('Auto Boost profile saves idempotently, revisions only while OFF, and toggles by CAS', () => {
  const store = new SqliteStore();
  try {
    const first = saveProfile(store);
    assert.equal(first.revision, 1);
    assert.equal(first.activationGeneration, 0);
    assert.equal(first.enabled, false);
    assert.equal(first.executionMode, 'DRY_RUN');

    const replay = saveProfile(store, { targetBudgetMinor: 400_000 });
    assert.deepEqual(replay, first);
    assert.equal(
      store.listAuditEvents({ eventType: 'AUTO_BOOST_PROFILE_SAVED' }).length,
      1,
    );

    const enabled = store.setAutoBoostEnabled({
      clientId: first.clientId,
      enabled: true,
      expectedRevision: 1,
      lineUserId: 'U-owner',
      sourceEventId: 'line-toggle-on-1',
      commandSequence: 2,
      now: '2026-07-20T09:01:00.000Z',
    });
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.activationGeneration, 1);
    assert.deepEqual(store.setAutoBoostEnabled({
      clientId: first.clientId,
      enabled: true,
      expectedRevision: 1,
      lineUserId: 'U-owner',
      sourceEventId: 'line-toggle-on-1',
      commandSequence: 2,
      now: '2026-07-20T09:02:00.000Z',
    }), enabled);

    assert.throws(() => saveProfile(store, {
      sourceEventId: 'line-profile-2',
      commandSequence: 3,
      now: '2026-07-20T09:03:00.000Z',
    }), (error) => error.code === 'AUTO_BOOST_PROFILE_ENABLED');

    const disabled = store.setAutoBoostEnabled({
      clientId: first.clientId,
      enabled: false,
      expectedRevision: 1,
      lineUserId: 'U-owner',
      sourceEventId: 'line-toggle-off-1',
      commandSequence: 4,
      now: '2026-07-20T09:04:00.000Z',
    });
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.activationGeneration, 1);

    const edited = saveProfile(store, {
      sourceEventId: 'line-profile-2',
      commandSequence: 5,
      targetBudgetMinor: 360_000,
      boostBps: 2_000,
      now: '2026-07-20T09:05:00.000Z',
    });
    assert.equal(edited.revision, 2);
    assert.equal(edited.activationGeneration, 1);
    assert.equal(edited.enabled, false);
    assert.equal(edited.targetBudgetMinor, 360_000);
    assert.equal(saveProfile(store, {
      sourceEventId: 'line-profile-1',
      commandSequence: 1,
      now: '2026-07-20T09:05:30.000Z',
    }).revision, 2);
    assert.equal(store.setAutoBoostEnabled({
      clientId: first.clientId,
      enabled: true,
      expectedRevision: 1,
      lineUserId: 'U-owner',
      sourceEventId: 'line-toggle-on-1',
      commandSequence: 2,
      now: '2026-07-20T09:05:45.000Z',
    }).enabled, false);
    assert.throws(() => store.setAutoBoostEnabled({
      clientId: first.clientId,
      enabled: true,
      expectedRevision: 1,
      lineUserId: 'U-owner',
      commandSequence: 6,
      now: '2026-07-20T09:06:00.000Z',
    }), (error) => error.code === 'CONCURRENT_MODIFICATION');
  } finally {
    store.close();
  }
});

test('Auto Boost occurrences materialize deterministically and recover tokenized leases', () => {
  const store = new SqliteStore();
  try {
    const profile = saveProfile(store);
    store.setAutoBoostEnabled({
      clientId: profile.clientId,
      enabled: true,
      expectedRevision: profile.revision,
      lineUserId: 'U-owner',
      commandSequence: 2,
      now: '2026-07-20T09:01:00.000Z',
    });
    const intervals = [
      {
        startAt: '2026-07-20T10:00:00.000Z',
        endAt: '2026-07-20T11:00:00.000Z',
      },
      {
        startAt: '2026-07-20T11:00:00.000Z',
        endAt: '2026-07-20T12:00:00.000Z',
      },
    ];
    const firstMaterialization = store.materializeAutoBoostOccurrences({
      clientId: profile.clientId,
      localDate: '2026-07-20',
      intervals,
      now: '2026-07-20T09:02:00.000Z',
    });
    const replayedMaterialization = store.materializeAutoBoostOccurrences({
      clientId: profile.clientId,
      localDate: '2026-07-20',
      intervals,
      now: '2026-07-20T09:03:00.000Z',
    });
    assert.equal(firstMaterialization.length, 4);
    assert.deepEqual(replayedMaterialization, firstMaterialization);
    assert.equal(new Set(firstMaterialization.map((item) => item.id)).size, 4);
    assert.equal(
      store.listAuditEvents({ eventType: 'AUTO_BOOST_OCCURRENCES_MATERIALIZED' }).length,
      1,
    );

    const initialBoost = store.claimDueAutoBoostOccurrences({
      now: '2026-07-20T10:00:00.000Z',
      leaseDurationMs: 120_000,
    });
    assert.equal(initialBoost.length, 1);
    assert.equal(initialBoost[0].phase, 'BOOST');
    store.finishAutoBoostOccurrence({
      id: initialBoost[0].id,
      leaseToken: initialBoost[0].leaseToken,
      status: 'DRY_RUN_COMPLETED',
      now: '2026-07-20T10:00:01.000Z',
    });

    const restoreBeforeBoost = store.claimDueAutoBoostOccurrences({
      now: '2026-07-20T11:00:00.000Z',
      limit: 1,
      leaseDurationMs: 120_000,
    });
    assert.equal(restoreBeforeBoost[0].phase, 'RESTORE');
    assert.equal(restoreBeforeBoost[0].attemptCount, 1);
    assert.equal(store.claimDueAutoBoostOccurrences({
      now: '2026-07-20T11:01:59.000Z',
      limit: 1,
      leaseDurationMs: 120_000,
    }).length, 0);

    const reclaimed = store.claimDueAutoBoostOccurrences({
      now: '2026-07-20T11:02:01.000Z',
      limit: 1,
      leaseDurationMs: 120_000,
    });
    assert.equal(reclaimed[0].id, restoreBeforeBoost[0].id);
    assert.equal(reclaimed[0].attemptCount, 2);
    assert.notEqual(reclaimed[0].leaseToken, restoreBeforeBoost[0].leaseToken);
    assert.throws(() => store.finishAutoBoostOccurrence({
      id: reclaimed[0].id,
      leaseToken: restoreBeforeBoost[0].leaseToken,
      status: 'DRY_RUN_COMPLETED',
      now: '2026-07-20T11:02:02.000Z',
    }), (error) => error.code === 'AUTO_BOOST_LEASE_MISMATCH');
    assert.equal(store.finishAutoBoostOccurrence({
      id: reclaimed[0].id,
      leaseToken: reclaimed[0].leaseToken,
      status: 'DRY_RUN_COMPLETED',
      now: '2026-07-20T11:02:02.000Z',
    }).status, 'DRY_RUN_COMPLETED');
    const [secondBoost] = store.claimDueAutoBoostOccurrences({
      now: '2026-07-20T11:02:03.000Z',
      limit: 1,
      leaseDurationMs: 120_000,
    });
    assert.equal(secondBoost.phase, 'BOOST');
    assert.equal(secondBoost.blockIndex, 1);

    const [safetyRestore] = store.claimDueAutoBoostOccurrences({
      now: '2026-07-20T12:11:00.000Z',
    });
    const uncertainBoost = store.listAutoBoostOccurrences({
      clientId: profile.clientId,
      localDate: '2026-07-20',
      phase: 'BOOST',
    }).find((item) => item.blockIndex === 1);
    assert.equal(uncertainBoost.status, 'OUTCOME_UNKNOWN');
    assert.equal(safetyRestore.phase, 'RESTORE');
    assert.equal(safetyRestore.blockIndex, 1);
    const finalRestore = store.listAutoBoostOccurrences({
      clientId: profile.clientId,
      localDate: '2026-07-20',
      phase: 'RESTORE',
    }).find((item) => item.blockIndex === 1);
    assert.equal(finalRestore.status, 'PROCESSING');
  } finally {
    store.close();
  }
});

test('a required RESTORE stays out of the claim limit but blocks every newer BOOST', () => {
  const store = new SqliteStore();
  try {
    const profile = saveProfile(store);
    store.setAutoBoostEnabled({
      clientId: profile.clientId,
      enabled: true,
      expectedRevision: profile.revision,
      lineUserId: 'U-owner',
      commandSequence: 2,
      now: '2026-07-20T09:01:00.000Z',
    });
    store.materializeAutoBoostOccurrences({
      clientId: profile.clientId,
      localDate: '2026-07-20',
      intervals: [
        {
          startAt: '2026-07-20T10:00:00.000Z',
          endAt: '2026-07-20T10:10:00.000Z',
        },
        {
          startAt: '2026-07-20T10:20:00.000Z',
          endAt: '2026-07-20T10:30:00.000Z',
        },
      ],
      deadlineMinutes: 30,
      now: '2026-07-20T09:02:00.000Z',
    });

    const [firstBoost] = store.claimDueAutoBoostOccurrences({
      now: '2026-07-20T10:09:59.000Z',
      limit: 1,
      leaseDurationMs: 900_000,
    });
    assert.equal(firstBoost.phase, 'BOOST');
    assert.equal(firstBoost.blockIndex, 0);

    assert.equal(store.claimDueAutoBoostOccurrences({
      now: '2026-07-20T10:20:00.000Z',
      limit: 1,
      leaseDurationMs: 120_000,
    }).length, 0);
    const waitingRestore = store.listAutoBoostOccurrences({
      clientId: profile.clientId,
      phase: 'RESTORE',
    }).find((item) => item.blockIndex === 0);
    assert.equal(waitingRestore.status, 'PENDING');
    assert.equal(waitingRestore.attemptCount, 0);

    store.finishAutoBoostOccurrence({
      id: firstBoost.id,
      leaseToken: firstBoost.leaseToken,
      status: 'DRY_RUN_COMPLETED',
      now: '2026-07-20T10:20:00.500Z',
    });
    const [releasedRestore] = store.claimDueAutoBoostOccurrences({
      now: '2026-07-20T10:20:01.000Z',
      limit: 1,
      leaseDurationMs: 120_000,
    });
    assert.equal(releasedRestore.id, waitingRestore.id);
    assert.equal(releasedRestore.phase, 'RESTORE');
    assert.equal(store.claimDueAutoBoostOccurrences({
      now: '2026-07-20T10:20:02.000Z',
      limit: 1,
      leaseDurationMs: 120_000,
    }).length, 0);
    store.finishAutoBoostOccurrence({
      id: releasedRestore.id,
      leaseToken: releasedRestore.leaseToken,
      status: 'DRY_RUN_COMPLETED',
      now: '2026-07-20T10:20:03.000Z',
    });
    const [newerBoost] = store.claimDueAutoBoostOccurrences({
      now: '2026-07-20T10:20:04.000Z',
      limit: 1,
      leaseDurationMs: 120_000,
    });
    assert.equal(newerBoost.phase, 'BOOST');
    assert.equal(newerBoost.blockIndex, 1);
  } finally {
    store.close();
  }
});

test('turning Auto Boost OFF and revoking its owner cancel durable pending work', () => {
  const store = new SqliteStore();
  try {
    const hash = createHash('sha256').update('pair-code').digest('hex');
    store.createLinePairing({
      clientId: baseProfile.clientId,
      codeHash: hash,
      createdAt: '2026-07-20T08:00:00.000Z',
      expiresAt: '2026-07-20T08:10:00.000Z',
    });
    store.consumeLinePairing({
      clientId: baseProfile.clientId,
      codeHash: hash,
      lineUserId: 'U-owner',
      consumedAt: '2026-07-20T08:01:00.000Z',
    });
    const profile = saveProfile(store);
    const enabled = store.setAutoBoostEnabled({
      clientId: profile.clientId,
      enabled: true,
      expectedRevision: profile.revision,
      lineUserId: 'U-owner',
      commandSequence: 2,
      now: '2026-07-20T09:01:00.000Z',
    });
    store.materializeAutoBoostOccurrences({
      clientId: profile.clientId,
      localDate: '2026-07-21',
      intervals: [{
        startAt: '2026-07-21T10:00:00.000Z',
        endAt: '2026-07-21T11:00:00.000Z',
      }],
      now: '2026-07-20T09:02:00.000Z',
    });
    const disabled = store.setAutoBoostEnabled({
      clientId: profile.clientId,
      enabled: false,
      expectedRevision: enabled.revision,
      lineUserId: 'U-owner',
      commandSequence: 3,
      now: '2026-07-20T09:03:00.000Z',
    });
    assert.equal(disabled.enabled, false);
    assert.deepEqual(
      store.listAutoBoostOccurrences({ clientId: profile.clientId })
        .map((item) => item.status),
      ['CANCELLED', 'CANCELLED'],
    );
    assert.equal(store.claimDueAutoBoostOccurrences({
      now: '2026-07-21T10:00:00.000Z',
    }).length, 0);

    const reenabled = store.setAutoBoostEnabled({
      clientId: profile.clientId,
      enabled: true,
      expectedRevision: profile.revision,
      lineUserId: 'U-owner',
      commandSequence: 4,
      now: '2026-07-20T09:04:00.000Z',
    });
    assert.equal(reenabled.activationGeneration, 2);
    store.materializeAutoBoostOccurrences({
      clientId: profile.clientId,
      localDate: '2026-07-22',
      intervals: [{
        startAt: '2026-07-22T10:00:00.000Z',
        endAt: '2026-07-22T11:00:00.000Z',
      }],
      now: '2026-07-20T09:05:00.000Z',
    });
    const revoked = store.revokeLineApprover({
      clientId: profile.clientId,
      lineUserId: 'U-owner',
      revokedAt: '2026-07-20T09:06:00.000Z',
    });
    assert.equal(revoked.counts.autoBoostProfilesDisabled, 1);
    assert.equal(revoked.counts.autoBoostOccurrencesCancelled, 2);
    assert.equal(store.getAutoBoostProfile({ clientId: profile.clientId }).enabled, false);
    assert.deepEqual(
      store.listAutoBoostOccurrences({
        clientId: profile.clientId,
        activationGeneration: 2,
      }).map((item) => item.status),
      ['CANCELLED', 'CANCELLED'],
    );
  } finally {
    store.close();
  }
});
