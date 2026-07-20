import assert from "node:assert/strict";
import test from "node:test";

import {
  bangkokDateTimeToInstant,
  bangkokLocalDate,
  buildBangkokDailyIntervals,
  calculateAutoBoostTargetMinor,
  mergeEffectiveIntervals,
  parseAutoBoostTimeWindow,
  percentToBasisPoints,
  validateAutoBoostWindows
} from "../src/auto-boost.js";

test("validates exact, same-day Auto Boost windows", () => {
  assert.deepEqual(parseAutoBoostTimeWindow("06:00-23:00"), {
    start: "06:00",
    end: "23:00"
  });
  assert.equal(parseAutoBoostTimeWindow("6:00-23:00"), null);
  assert.equal(parseAutoBoostTimeWindow("23:00-06:00"), null);
  assert.equal(parseAutoBoostTimeWindow("12:00 - 13:00"), null);

  assert.deepEqual(validateAutoBoostWindows([
    { start: "15:00", end: "16:00" },
    { start: "12:00", end: "13:00" }
  ]).map(({ start, end }) => ({ start, end })), [
    { start: "12:00", end: "13:00" },
    { start: "15:00", end: "16:00" }
  ]);
  assert.throws(
    () => validateAutoBoostWindows([{ start: "20:00", end: "20:00" }]),
    /same day/
  );
  assert.throws(() => validateAutoBoostWindows([]), /between 1 and 24/);
  assert.throws(
    () => validateAutoBoostWindows(Array.from({ length: 25 }, () => ({ start: "12:00", end: "13:00" }))),
    /between 1 and 24/
  );
});

test("merges touching and overlapping effective [start-lead,end) intervals", () => {
  assert.deepEqual(mergeEffectiveIntervals([
    { start: "12:00", end: "13:00" },
    { start: "13:05", end: "14:00" },
    { start: "15:00", end: "16:00" },
    { start: "16:10", end: "17:00" }
  ], 10), [
    { startMinute: 11 * 60 + 50, endMinute: 14 * 60 },
    { startMinute: 14 * 60 + 50, endMinute: 17 * 60 }
  ]);

  assert.deepEqual(mergeEffectiveIntervals([
    { start: "12:00", end: "13:00" },
    { start: "13:11", end: "14:00" }
  ], 10), [
    { startMinute: 11 * 60 + 50, endMinute: 13 * 60 },
    { startMinute: 13 * 60 + 1, endMinute: 14 * 60 }
  ]);
});

test("calculates every target from stored minor-unit base without compounding", () => {
  const baseBudgetMinor = 300_000;
  const boostBps = percentToBasisPoints(10);
  assert.equal(boostBps, 1_000);
  assert.equal(calculateAutoBoostTargetMinor(baseBudgetMinor, boostBps), 330_000);
  assert.equal(calculateAutoBoostTargetMinor(baseBudgetMinor, boostBps), 330_000);
  assert.notEqual(calculateAutoBoostTargetMinor(baseBudgetMinor, boostBps), 363_000);
  assert.equal(calculateAutoBoostTargetMinor(101, 1_000), 111);
  assert.throws(() => calculateAutoBoostTargetMinor(0, boostBps), /positive/);
});

test("resolves recurring schedule instants in Bangkok, including prior-day lead", () => {
  assert.equal(
    bangkokDateTimeToInstant("2026-07-21", "11:50").toISOString(),
    "2026-07-21T04:50:00.000Z"
  );
  assert.equal(bangkokLocalDate("2026-07-20T18:00:00.000Z"), "2026-07-21");
  assert.deepEqual(buildBangkokDailyIntervals({
    localDate: "2026-07-21",
    leadMinutes: 10,
    windows: [
      { start: "00:05", end: "01:00" },
      { start: "12:00", end: "13:00" }
    ]
  }), [
    {
      blockIndex: 0,
      startAt: "2026-07-20T16:55:00.000Z",
      endAt: "2026-07-20T18:00:00.000Z"
    },
    {
      blockIndex: 1,
      startAt: "2026-07-21T04:50:00.000Z",
      endAt: "2026-07-21T06:00:00.000Z"
    }
  ]);
  assert.throws(
    () => bangkokDateTimeToInstant("2026-02-30", "12:00"),
    /valid calendar date/
  );
});
