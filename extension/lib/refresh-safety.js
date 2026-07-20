(function installWhaleBuddyRefreshSafety(root) {
  "use strict";

  const SIGNALS = Object.freeze([
    ["bindingVerified", true, "BINDING_UNVERIFIED"],
    ["documentReady", true, "DOCUMENT_NOT_READY"],
    ["recentUserActivity", false, "RECENT_USER_ACTIVITY"],
    ["dirtyControl", false, "UNSAVED_CONTROL"],
    ["focusedEditable", false, "EDITABLE_FOCUSED"],
    ["visibleDialog", false, "DIALOG_OPEN"],
    ["pageBusy", false, "PAGE_BUSY"],
    ["pendingSubmission", false, "SUBMISSION_PENDING"]
  ]);

  function evaluateRefreshSafety(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return Object.freeze({ safeToReload: false, reasons: Object.freeze(["SAFETY_STATE_INVALID"]) });
    }
    const reasons = [];
    for (const [field, expected, reason] of SIGNALS) {
      if (input[field] !== expected) reasons.push(reason);
    }
    return Object.freeze({
      safeToReload: reasons.length === 0,
      reasons: Object.freeze(reasons)
    });
  }

  root.WhaleBuddyRefreshSafety = Object.freeze({ evaluateRefreshSafety });
})(globalThis);

