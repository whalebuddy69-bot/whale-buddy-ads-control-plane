(function installTikTokCollector() {
  "use strict";

  const parser = globalThis.WhaleBuddyTikTokParser;
  const refreshSafety = globalThis.WhaleBuddyRefreshSafety;
  const COLLECT_MESSAGE = "WB_COLLECT_TIKTOK_LIVE";
  const REFRESH_IF_SAFE_MESSAGE = "WB_REFRESH_TIKTOK_IF_SAFE";
  const USER_QUIET_MILLISECONDS = 5 * 60_000;
  const RETRYABLE_CODES = new Set([
    "TABLE_NOT_READY",
    "TABLE_SHAPE_CHANGED",
    "CAMPAIGN_NOT_FOUND",
    "DOM_ADVERTISER_UNVERIFIED"
  ]);
  const dirtyControls = new Set();
  let lastTrustedInteractionAt = null;
  let pendingSubmission = false;

  function collectorError(code, message, details) {
    const error = new Error(message);
    error.code = code;
    if (details !== undefined) error.details = details;
    return error;
  }

  function exactString(value, field, pattern) {
    if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
      throw collectorError("INVALID_BINDING", `${field} ไม่ถูกต้อง`);
    }
    if (pattern && !pattern.test(value)) {
      throw collectorError("INVALID_BINDING", `${field} ไม่ถูกต้อง`);
    }
    return value;
  }

  function validateBinding(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw collectorError("INVALID_BINDING", "ไม่พบข้อมูลบัญชีที่อนุญาต");
    }
    return Object.freeze({
      advertiserId: exactString(input.advertiserId, "advertiserId", /^\d{6,32}$/u),
      businessCenterId: exactString(input.businessCenterId, "businessCenterId", /^\d{6,32}$/u),
      expectedTikTokAccountId: exactString(
        input.expectedTikTokAccountId,
        "expectedTikTokAccountId",
        /^\d{6,32}$/u
      ),
      campaignStart: exactString(input.campaignStart, "campaignStart", /^\d{2}:\d{2}:\d{2}$/u),
      sellerMode: exactString(input.sellerMode, "sellerMode"),
      pageType: exactString(input.pageType, "pageType")
    });
  }

  function exactSearchParameter(url, key, expected) {
    const values = url.searchParams.getAll(key);
    if (values.length !== 1 || values[0] !== expected) {
      throw collectorError("URL_IDENTITY_MISMATCH", `หน้า TikTok มี ${key} ไม่ตรงบัญชีที่อนุญาต`);
    }
  }

  function assertUrlIdentity(binding) {
    const url = new URL(globalThis.location.href);
    if (
      url.origin !== "https://ads.tiktok.com" ||
      url.pathname !== "/i18n/gmv-max/dashboard"
    ) {
      throw collectorError("URL_IDENTITY_MISMATCH", "ไม่ใช่หน้า LIVE GMV Max ที่รองรับ");
    }
    exactSearchParameter(url, "aadvid", binding.advertiserId);
    exactSearchParameter(url, "bc_id", binding.businessCenterId);
    exactSearchParameter(url, "oec_seller_id", binding.sellerMode);
    exactSearchParameter(url, "type", binding.pageType);
  }

  function assertVisibleAdvertiser(binding) {
    const ignoredTags = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
    const leaves = [...document.body.querySelectorAll("*")].filter((element) =>
      element.childElementCount === 0 &&
      !ignoredTags.has(element.tagName) &&
      parser.normalizeText(element.textContent) === binding.advertiserId
    );
    if (leaves.length !== 1) {
      throw collectorError(
        "DOM_ADVERTISER_UNVERIFIED",
        "ยืนยัน Advertiser ID ที่แสดงบนหน้าไม่ได้",
        { count: leaves.length }
      );
    }
  }

  function directChildrenByTag(element, tagName) {
    return [...element.children].filter((child) => child.tagName === tagName);
  }

  function visibleText(element) {
    return typeof element.innerText === "string" ? element.innerText : (element.textContent ?? "");
  }

  function isVisible(element) {
    if (!(element instanceof Element) || !element.isConnected) return false;
    const style = globalThis.getComputedStyle(element);
    return style.display !== "none"
      && style.visibility !== "hidden"
      && style.opacity !== "0"
      && element.getClientRects().length > 0;
  }

  function editableControl(element) {
    if (!(element instanceof Element)) return null;
    const candidate = element.matches(
      "input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='textbox'], [role='combobox'], [role='spinbutton']"
    )
      ? element
      : element.closest(
        "[contenteditable=''], [contenteditable='true'], [role='textbox'], [role='combobox'], [role='spinbutton']"
      );
    if (!candidate) return null;
    if (candidate.tagName !== "INPUT") return candidate;
    return new Set(["button", "hidden", "image", "reset", "submit"])
      .has(String(candidate.getAttribute("type") ?? "text").toLowerCase())
      ? null
      : candidate;
  }

  function isEditable(element) {
    return editableControl(element) !== null;
  }

  function controlIsDirty(element) {
    const control = editableControl(element);
    if (!control || !control.isConnected) return false;
    if (control.matches("[contenteditable=''], [contenteditable='true']")) {
      return dirtyControls.has(control) || parser.normalizeText(control.textContent) !== "";
    }
    if (control.tagName === "SELECT") {
      return [...control.options].some((option) => option.selected !== option.defaultSelected);
    }
    if (control.tagName === "INPUT") {
      const type = String(control.type ?? "text").toLowerCase();
      if (type === "checkbox" || type === "radio") return control.checked !== control.defaultChecked;
    }
    return "value" in control && "defaultValue" in control
      ? control.value !== control.defaultValue
      : dirtyControls.has(control);
  }

  function pruneDirtyControls() {
    for (const element of dirtyControls) {
      if (!element.isConnected) dirtyControls.delete(element);
    }
  }

  function refreshSafetySignals(binding) {
    let bindingVerified = false;
    try {
      assertUrlIdentity(binding);
      assertVisibleAdvertiser(binding);
      bindingVerified = true;
    } catch {
      bindingVerified = false;
    }
    pruneDirtyControls();
    const activeElement = document.activeElement;
    const visibleDialog = [...document.querySelectorAll("dialog[open], [role='dialog'], [aria-modal='true']")]
      .some(isVisible);
    const pageBusy = [...document.querySelectorAll("[aria-busy='true']")].some(isVisible);
    return {
      bindingVerified,
      documentReady: document.readyState === "complete",
      recentUserActivity: lastTrustedInteractionAt !== null
        && Date.now() - lastTrustedInteractionAt < USER_QUIET_MILLISECONDS,
      dirtyControl: dirtyControls.size > 0 || [...document.querySelectorAll(
        "input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='textbox'], [role='combobox'], [role='spinbutton']"
      )].some(controlIsDirty),
      focusedEditable: isEditable(activeElement),
      visibleDialog,
      pageBusy,
      pendingSubmission
    };
  }

  function decideRefresh(binding) {
    if (!refreshSafety?.evaluateRefreshSafety) {
      return { safeToReload: false, reasons: ["SAFETY_MODULE_UNAVAILABLE"] };
    }
    return refreshSafety.evaluateRefreshSafety(refreshSafetySignals(binding));
  }

  function extractTableModel() {
    const tables = [...document.querySelectorAll("table")];
    if (tables.length === 0) {
      throw collectorError("TABLE_NOT_READY", "ตาราง TikTok ยังโหลดไม่เสร็จ");
    }
    if (tables.length !== 1) {
      throw collectorError("TABLE_AMBIGUOUS", "พบตาราง TikTok มากกว่าหนึ่งตาราง", {
        count: tables.length
      });
    }

    const table = tables[0];
    const heads = directChildrenByTag(table, "THEAD");
    if (heads.length !== 1) {
      throw collectorError("TABLE_SHAPE_CHANGED", "โครงสร้างหัวตารางเปลี่ยนไป");
    }
    const headerRows = directChildrenByTag(heads[0], "TR");
    if (headerRows.length !== 1) {
      throw collectorError("TABLE_SHAPE_CHANGED", "จำนวนแถวหัวตารางเปลี่ยนไป");
    }
    const headerCells = [...headerRows[0].children];
    if (headerCells.some((cell) => cell.tagName !== "TH")) {
      throw collectorError("TABLE_SHAPE_CHANGED", "หัวตารางมีชนิดช่องที่ไม่รองรับ");
    }

    const bodies = directChildrenByTag(table, "TBODY");
    if (bodies.length === 0) {
      throw collectorError("TABLE_NOT_READY", "รายการแคมเปญยังโหลดไม่เสร็จ");
    }
    const rowElements = bodies.flatMap((body) => directChildrenByTag(body, "TR"));
    const rows = rowElements.map((row, rowIndex) => {
      const cells = [...row.children];
      if (cells.some((cell) => cell.tagName !== "TD")) {
        throw collectorError("TABLE_SHAPE_CHANGED", "แถวข้อมูลมีชนิดช่องที่ไม่รองรับ", {
          rowIndex
        });
      }
      return cells.map(visibleText);
    });
    return {
      headers: headerCells.map(visibleText),
      rows
    };
  }

  function collectOnce(binding) {
    assertUrlIdentity(binding);
    assertVisibleAdvertiser(binding);
    const model = extractTableModel();
    const observation = parser.parseTableModel({
      ...model,
      expectedTikTokAccountId: binding.expectedTikTokAccountId,
      expectedCampaignStart: binding.campaignStart,
      now: new Date()
    });
    return {
      ...observation,
      observedAt: new Date().toISOString()
    };
  }

  function waitForMutation(timeoutMilliseconds) {
    return new Promise((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        observer.disconnect();
        clearTimeout(timer);
        resolve();
      };
      const observer = new MutationObserver(finish);
      const timer = setTimeout(finish, timeoutMilliseconds);
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true
      });
    });
  }

  async function collectWithBoundedWait(binding) {
    const deadline = Date.now() + 10_000;
    let lastError;
    while (Date.now() <= deadline) {
      try {
        return collectOnce(binding);
      } catch (error) {
        lastError = error;
        if (!RETRYABLE_CODES.has(error?.code) || error?.details?.count > 1) throw error;
      }
      await waitForMutation(Math.min(500, Math.max(1, deadline - Date.now())));
    }
    throw lastError ?? collectorError("TABLE_NOT_READY", "หน้า TikTok ยังไม่พร้อมให้อ่าน");
  }

  function safeFailure(error) {
    return {
      ok: false,
      error: {
        code: typeof error?.code === "string" ? error.code : "COLLECTOR_ERROR",
        message: typeof error?.message === "string" ? error.message : "อ่านหน้า TikTok ไม่สำเร็จ"
      }
    };
  }

  function recordInteraction(event) {
    if (event.isTrusted) lastTrustedInteractionAt = Date.now();
  }

  for (const eventName of ["pointerdown", "keydown", "touchstart", "focusin"]) {
    document.addEventListener(eventName, recordInteraction, true);
  }
  for (const eventName of ["beforeinput", "input", "change"]) {
    document.addEventListener(eventName, (event) => {
      recordInteraction(event);
      const control = editableControl(event.target);
      if (event.isTrusted && control) dirtyControls.add(control);
    }, true);
  }
  document.addEventListener("submit", (event) => {
    recordInteraction(event);
    if (event.isTrusted) pendingSubmission = true;
  }, true);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender?.id !== chrome.runtime.id) return false;
    if (![COLLECT_MESSAGE, REFRESH_IF_SAFE_MESSAGE].includes(message?.type)) return false;
    let binding;
    try {
      binding = validateBinding(message.binding);
    } catch (error) {
      sendResponse(safeFailure(error));
      return false;
    }
    if (message.type === REFRESH_IF_SAFE_MESSAGE) {
      const decision = decideRefresh(binding);
      if (!decision.safeToReload) {
        sendResponse({ ok: true, safeToReload: false, reasons: decision.reasons });
        return false;
      }
      // The safety decision and navigation happen in the same content-script
      // task, so a user edit cannot interleave between them.
      sendResponse({ ok: true, safeToReload: true, reloadStarted: true });
      globalThis.location.reload();
      return false;
    }
    collectWithBoundedWait(binding)
      .then((observation) => sendResponse({ ok: true, observation }))
      .catch((error) => sendResponse(safeFailure(error)));
    return true;
  });
})();
