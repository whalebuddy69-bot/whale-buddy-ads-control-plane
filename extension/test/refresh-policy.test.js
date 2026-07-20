import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PAGE_REFRESH_INTERVAL_MINUTES,
  PAGE_REFRESH_INTERVALS_MINUTES,
  normalizePageRefreshSettings,
  pageRefreshDue,
  validatePageRefreshSettings
} from "../lib/refresh-policy.js";

test("pilot fallback defaults to an explicit two-minute cadence and can be disabled", () => {
  assert.equal(DEFAULT_PAGE_REFRESH_INTERVAL_MINUTES, 2);
  assert.deepEqual(PAGE_REFRESH_INTERVALS_MINUTES, [2, 5, 10, 15, 30]);
  assert.deepEqual(normalizePageRefreshSettings(undefined), {
    enabled: true,
    intervalMinutes: 2
  });
  assert.deepEqual(normalizePageRefreshSettings({ enabled: false, intervalMinutes: 2 }), {
    enabled: false,
    intervalMinutes: 2
  });
});

test("corrupt refresh settings fail closed and UI updates accept only approved intervals", () => {
  assert.deepEqual(normalizePageRefreshSettings({ enabled: true, intervalMinutes: 1 }), {
    enabled: false,
    intervalMinutes: 2
  });
  assert.deepEqual(validatePageRefreshSettings({ enabled: true, intervalMinutes: 5 }), {
    enabled: true,
    intervalMinutes: 5
  });
  assert.throws(
    () => validatePageRefreshSettings({ enabled: true, intervalMinutes: 1 }),
    /interval is not allowed/
  );
  assert.throws(
    () => validatePageRefreshSettings({ enabled: "true", intervalMinutes: 2 }),
    /enabled must be a boolean/
  );
});

test("refresh becomes due at the configured boundary but not after clock rollback", () => {
  const now = new Date("2026-07-20T05:02:00.000Z");
  assert.equal(pageRefreshDue({ settings: undefined, lastReloadAt: null, now }), true);
  assert.equal(pageRefreshDue({
    settings: { enabled: true, intervalMinutes: 2 },
    lastReloadAt: "2026-07-20T05:00:01.000Z",
    now
  }), false);
  assert.equal(pageRefreshDue({
    settings: { enabled: true, intervalMinutes: 2 },
    lastReloadAt: "2026-07-20T05:00:00.000Z",
    now
  }), true);
  assert.equal(pageRefreshDue({
    settings: { enabled: true, intervalMinutes: 2 },
    lastReloadAt: "2026-07-20T05:03:00.000Z",
    now
  }), false);
  assert.equal(pageRefreshDue({
    settings: { enabled: false, intervalMinutes: 2 },
    lastReloadAt: null,
    now
  }), false);
});

