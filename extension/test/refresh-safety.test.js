import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

await import("../lib/refresh-safety.js");
const { evaluateRefreshSafety } = globalThis.WhaleBuddyRefreshSafety;

function safeSignals(overrides = {}) {
  return {
    bindingVerified: true,
    documentReady: true,
    recentUserActivity: false,
    dirtyControl: false,
    focusedEditable: false,
    visibleDialog: false,
    pageBusy: false,
    pendingSubmission: false,
    ...overrides
  };
}

test("reload is allowed only when every fail-closed signal is safe", () => {
  assert.deepEqual(evaluateRefreshSafety(safeSignals()), {
    safeToReload: true,
    reasons: []
  });
  for (const [field, value, reason] of [
    ["bindingVerified", false, "BINDING_UNVERIFIED"],
    ["documentReady", false, "DOCUMENT_NOT_READY"],
    ["recentUserActivity", true, "RECENT_USER_ACTIVITY"],
    ["dirtyControl", true, "UNSAVED_CONTROL"],
    ["focusedEditable", true, "EDITABLE_FOCUSED"],
    ["visibleDialog", true, "DIALOG_OPEN"],
    ["pageBusy", true, "PAGE_BUSY"],
    ["pendingSubmission", true, "SUBMISSION_PENDING"]
  ]) {
    const decision = evaluateRefreshSafety(safeSignals({ [field]: value }));
    assert.equal(decision.safeToReload, false, field);
    assert.deepEqual(decision.reasons, [reason]);
  }
});

test("missing or non-boolean safety signals never default to safe", () => {
  assert.equal(evaluateRefreshSafety(null).safeToReload, false);
  const missing = safeSignals();
  delete missing.dirtyControl;
  assert.equal(evaluateRefreshSafety(missing).safeToReload, false);
  assert.deepEqual(evaluateRefreshSafety(missing).reasons, ["UNSAVED_CONTROL"]);
});

test("content script owns the final atomic safety decision before location reload", async () => {
  const content = await readFile(new URL("../content/tiktok-live-gmv-max.js", import.meta.url), "utf8");
  const worker = await readFile(new URL("../service-worker.js", import.meta.url), "utf8");
  assert.match(content, /decision\.safeToReload/u);
  assert.match(content, /sendResponse\(\{ ok: true, safeToReload: true, reloadStarted: true \}\);\s*globalThis\.location\.reload\(\)/u);
  assert.doesNotMatch(worker, /chrome\.tabs\.reload/u);
  assert.match(worker, /changeInfo\.status === "loading"/u);
  assert.match(worker, /changeInfo\.status !== "complete"/u);
});

