import assert from "node:assert/strict";
import test from "node:test";
import { fromMinor, toMinor } from "../src/money.js";

test("currency conversion is integer-safe", () => {
  assert.equal(toMinor(15000.25, "THB"), 1500025);
  assert.equal(fromMinor(1500025, "THB"), 15000.25);
  assert.equal(toMinor(15000, "JPY"), 15000);
  assert.throws(() => toMinor(1.001, "THB"), /more precision/);
});
