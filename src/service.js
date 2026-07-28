import crypto from "node:crypto";
import { DomainError, RequestState, createBudgetRequest, isTerminalState } from "./domain.js";
import {
  buildBudgetAlertMessage,
  buildObservedBudgetChangeMessage,
  buildBudgetConfirmationMessage,
  buildResultMessage,
  parseBudgetText,
  parsePairingText,
  parsePostbackData,
  requestCodeFor
} from "./line.js";
import { fromMinor, toMinor } from "./money.js";
import {
  buildAgencyClientPickerMessage,
  buildAgencyControlMenuMessage,
  buildAgencyPerformanceReportMessage,
  buildAutoBoostDryRunOccurrenceMessage,
  buildAutoBoostSetupTemplateMessage,
  buildAutoBoostStatusMessage,
  buildCampaignAdjustmentMessage,
  buildCampaignCreateTemplateMessage,
  buildCampaignPauseChoicesMessage,
  buildControlConfirmationMessage,
  buildControlMenuMessage,
  buildCouponReminderMessage,
  buildPerformanceReportMessage,
  buildShortcutListMessage,
  controlHelpText,
  newControlRequestId,
  parseControlCommand,
  parseControlPostbackData
} from "./line-controls.js";
import { buildTikTokPreflightMessage } from "./tiktok-api-control.js";
import {
  bangkokLocalDate,
  buildBangkokDailyIntervals,
  calculateAutoBoostTargetMinor,
  mergeEffectiveIntervals,
  percentToBasisPoints,
  validateAutoBoostWindows
} from "./auto-boost.js";
import {
  TELEMETRY_UI_SCHEMA_FINGERPRINT_V1,
  TELEMETRY_UI_SCHEMA_FINGERPRINT_V2,
  telemetryUiCampaignRef
} from "./telemetry.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function safeError(error) {
  return {
    code: error?.code ? String(error.code) : "EXECUTION_ERROR",
    message: error?.message || "Unknown error",
    outcomeKnown: error?.outcomeKnown !== false,
    requestId: error?.requestId == null ? null : String(error.requestId)
  };
}

function webhookEventId(event) {
  if (event.webhookEventId) return event.webhookEventId;
  const stableEvent = {
    type: event.type,
    timestamp: event.timestamp ?? null,
    source: event.source ?? null,
    message: event.message == null
      ? null
      : { id: event.message.id ?? null, type: event.message.type ?? null, text: event.message.text ?? null },
    postback: event.postback == null ? null : { data: event.postback.data ?? null }
  };
  return `legacy-${crypto.createHash("sha256").update(JSON.stringify(stableEvent)).digest("hex").slice(0, 32)}`;
}

function stableRetryKey(...parts) {
  const hex = crypto.createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ["8", "9", "a", "b"][Number.parseInt(hex[16], 16) % 4];
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

function pairingCodeHash(clientId, code) {
  return crypto.createHash("sha256").update(`${clientId}\u0000${code}`).digest("hex");
}

function controlRequestIdForEvent(eventId) {
  if (!eventId) return newControlRequestId();
  const digest = crypto.createHash("sha256").update(String(eventId)).digest("hex").slice(0, 40);
  return `ca_${digest}`;
}

function allowsManualTarget(request) {
  if (request?.metadata?.allowManualTarget !== undefined) {
    return request.metadata.allowManualTarget !== false;
  }
  // Older dynamic request snapshots already carry this authority inside the
  // policy object. Static requests predate the flag and retain manual input.
  return request?.metadata?.dynamicPolicy?.allowManualTarget !== false;
}

function normalizedLineCommand(event) {
  const userId = event.source?.userId;
  if (!userId) return null;
  if (event.type === "postback" && parseControlPostbackData(event.postback?.data)) {
    return {
      kind: "control_postback",
      userId,
      data: event.postback.data,
      sourceType: event.source?.type ?? null
    };
  }
  if (event.type === "postback" && parsePostbackData(event.postback?.data)) {
    return { kind: "postback", userId, data: event.postback.data };
  }
  if (event.type === "message" && event.message?.type === "text") {
    const pairing = parsePairingText(event.message.text);
    if (pairing) {
      return {
        kind: "pairing",
        userId,
        clientId: pairing.clientId,
        codeHash: pairingCodeHash(pairing.clientId, pairing.code),
        sourceType: event.source?.type ?? null
      };
    }
    if (parseBudgetText(event.message.text)) {
      return { kind: "budget_text", userId, text: event.message.text };
    }
    const control = parseControlCommand(event.message.text);
    if (control) {
      return {
        kind: "control_command",
        userId,
        command: control,
        sourceType: event.source?.type ?? null
      };
    }
    return {
      kind: "control_fallback",
      userId,
      sourceType: event.source?.type ?? null
    };
  }
  return null;
}

function calculateSuggestedTarget(currentBudget, campaign) {
  if (campaign.dynamicPolicy) {
    return Math.min(
      campaign.maxDailyBudget,
      currentBudget * (1 + campaign.dynamicPolicy.presetPercent / 100)
    );
  }
  return Math.min(
    campaign.maxDailyBudget,
    Math.max(currentBudget * campaign.suggestionMultiplier, currentBudget + campaign.minIncrease)
  );
}

function zonedDateTimeParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

function localDateFor(date, timeZone) {
  const parts = zonedDateTimeParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function renderCampaignNameTemplate(template, date, client) {
  const localDate = localDateFor(date, client.timezone);
  return String(template)
    .replaceAll("{date}", localDate)
    .replaceAll("{start}", client.liveWindow?.start ?? "00:00")
    .slice(0, 120);
}

function localBangkokDateTime(localDate, localTime, timezone) {
  if (timezone !== "Asia/Bangkok") {
    throw new DomainError(
      "UNSUPPORTED_TIMEZONE",
      "Coupon scheduling currently supports Asia/Bangkok only"
    );
  }
  const parsed = new Date(`${localDate}T${localTime}:00+07:00`);
  if (Number.isNaN(parsed.getTime())) {
    throw new DomainError("INVALID_SCHEDULE", "Coupon date or time is invalid");
  }
  const roundTrip = zonedDateTimeParts(parsed, timezone);
  if (`${roundTrip.year}-${roundTrip.month}-${roundTrip.day}` !== localDate
      || `${roundTrip.hour}:${roundTrip.minute}` !== localTime) {
    throw new DomainError("INVALID_SCHEDULE", "Coupon date or time is invalid");
  }
  return parsed;
}

function timeMinutes(value) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function isWithinLiveWindow(date, timeZone, liveWindow) {
  const parts = zonedDateTimeParts(date, timeZone);
  const nowMinutes = Number(parts.hour) * 60 + Number(parts.minute);
  const start = timeMinutes(liveWindow.start);
  const end = timeMinutes(liveWindow.end);
  if (start === end) return false;
  return start < end
    ? nowMinutes >= start && nowMinutes < end
    : nowMinutes >= start || nowMinutes < end;
}

function dynamicAccountIds(info) {
  const values = [];
  const add = (value) => {
    if (value == null || value === "") return;
    if (Array.isArray(value)) return value.forEach(add);
    if (typeof value === "object") {
      add(value.tiktok_account_id);
      add(value.tiktokAccountId);
      add(value.identity_id);
      return;
    }
    values.push(String(value));
  };
  add(info?.tiktokAccountId);
  add(info?.tiktokAccountIds);
  add(info?.raw?.tiktok_account_id);
  add(info?.raw?.tiktok_account_ids);
  add(info?.raw?.tiktok_accounts);
  add(info?.raw?.identity_id);
  add(info?.raw?.identity_ids);
  add(info?.raw?.identities);
  return [...new Set(values)];
}

function dynamicAuthoritySnapshot(client, policyLocalDate) {
  return {
    authoritySchemaVersion: 1,
    presetPercent: client.budgetIncrease.presetPercent,
    allowManualTarget: client.budgetIncrease.allowManualTarget,
    revision: client.budgetPolicy.revision,
    effectiveFrom: client.budgetPolicy.effectiveFrom,
    maxDailyBudget: client.budgetPolicy.maxDailyBudget,
    policyLocalDate,
    expectedTikTokAccountId: client.campaignSelector.expectedTikTokAccountId,
    liveWindow: {
      start: client.liveWindow.start,
      end: client.liveWindow.end
    },
    timezone: client.timezone,
    selectorKind: client.campaignSelector.kind,
    currency: client.campaignSelector.currency,
    requireExactlyOne: client.campaignSelector.requireExactlyOne
  };
}

// Serialize every field that grants dynamic execution authority in a fixed
// order. Comparing this canonical form avoids relying on operators remembering
// to bump revision whenever any individual guardrail changes.
function canonicalDynamicAuthority(policy) {
  return JSON.stringify({
    authoritySchemaVersion: policy?.authoritySchemaVersion ?? null,
    presetPercent: policy?.presetPercent ?? null,
    allowManualTarget: policy?.allowManualTarget ?? null,
    revision: policy?.revision ?? null,
    effectiveFrom: policy?.effectiveFrom ?? null,
    maxDailyBudget: policy?.maxDailyBudget ?? null,
    policyLocalDate: policy?.policyLocalDate ?? null,
    expectedTikTokAccountId: policy?.expectedTikTokAccountId ?? null,
    liveWindow: policy?.liveWindow == null
      ? null
      : {
          start: policy.liveWindow.start ?? null,
          end: policy.liveWindow.end ?? null
        },
    timezone: policy?.timezone ?? null,
    selectorKind: policy?.selectorKind ?? null,
    currency: policy?.currency ?? null,
    requireExactlyOne: policy?.requireExactlyOne ?? null
  });
}

function dynamicAuthorityDigest(canonical) {
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function telemetryOnlyRequest(request) {
  return request?.metadata?.telemetryOnly === true
    || request?.metadata?.executionMode === "APPROVAL_ONLY"
    || request?.metadata?.source === "CHROME_TELEMETRY_DRY_RUN";
}

function thresholdReached(costMinor, budgetMinor, threshold) {
  const scale = 1_000_000;
  const scaledThreshold = Math.round(threshold * scale);
  return BigInt(costMinor) * BigInt(scale) >= BigInt(budgetMinor) * BigInt(scaledThreshold);
}

export class BudgetGuardService {
  constructor({
    config,
    store,
    tiktok,
    tiktokApiControl = null,
    line,
    executionEnabled = false,
    telemetryAlertsEnabled = false,
    logger = console,
    now = () => new Date()
  }) {
    this.config = config;
    this.store = store;
    this.tiktok = tiktok;
    this.tiktokApiControl = tiktokApiControl;
    this.line = line;
    this.executionEnabled = executionEnabled;
    this.telemetryAlertsEnabled = telemetryAlertsEnabled;
    this.logger = logger;
    this.now = now;
  }

  #clientById(clientId) {
    return this.config.clients.find((client) => client.id === clientId) ?? null;
  }

  #approversForClient(client) {
    const configured = client.lineApproverUserIds ?? [];
    const paired = typeof this.store.listLineApprovers === "function"
      ? this.store.listLineApprovers({ clientId: client.id }).map((item) => item.lineUserId)
      : [];
    return [...new Set([...configured, ...paired])].sort();
  }

  #isCurrentApprover(client, userId) {
    return this.#approversForClient(client).includes(userId);
  }

  #authorizedLineControlClients(userId) {
    if (!userId) return [];
    return this.config.clients
      .filter((client) => client.lineControl?.enabled === true && this.#isCurrentApprover(client, userId))
      .sort((left, right) => {
        const leftName = left.lineControl?.aliases?.[0] ?? left.name ?? left.id;
        const rightName = right.lineControl?.aliases?.[0] ?? right.name ?? right.id;
        return String(leftName).localeCompare(String(rightName), "th");
      });
  }

  #privateChatOnlyMessage() {
    return {
      type: "text",
      text: "กรุณาใช้คำสั่งควบคุมโฆษณาในแชตส่วนตัวกับ LINE OA เท่านั้น"
    };
  }

  #lineControlPairingRequiredMessage() {
    return {
      type: "text",
      text: "LINE นี้ยังไม่มีสิทธิ์ใช้คำสั่งดังกล่าว กรุณาเลือกบัญชีจากเมนูหรือขอรหัสจับคู่จากผู้ดูแลระบบ"
    };
  }

  #lineControlSelectionRequiredMessage() {
    return {
      type: "text",
      text: "ไม่สามารถใช้บัญชีจากคำสั่งนี้ได้ กรุณาเลือกบัญชีจากเมนู"
    };
  }

  #invalidControlTemplateMessage(template) {
    const text = template === "shortcut"
      ? "Template Shortcut ยังไม่ครบ 5 บรรทัด กรุณาตรวจชื่อ, งบ, ROI และจุดเติมงบ หรือกดสร้างแคมเปญใหม่จากเมนู"
      : template === "auto_boost"
        ? "Template Auto Boost ยังไม่ครบ กรุณาตรวจงบฐาน, เปอร์เซ็นต์, นาทีล่วงหน้า และช่วงเวลา หรือกด Auto Boost จากเมนู"
        : "คำสั่งปรับค่ายังไม่ถูกรูปแบบ จำนวนต้องเป็นเลขบวก กรุณาคัดลอก Template จากเมนู “ปรับเพิ่ม / ลด”";
    return {
      type: "text",
      text,
      quickReply: {
        items: [{
          type: "action",
          action: { type: "message", label: "กลับเมนู", text: "เมนู" }
        }]
      }
    };
  }

  #agencySnapshotEntries(clients) {
    return clients.map((client) => {
      const { snapshot, stale } = this.#latestControlSnapshot(client);
      return { client, snapshot, stale };
    });
  }

  #agencyCommandMessage(command, userId) {
    if (!new Set([
      "agency_menu",
      "agency_report",
      "agency_section",
      "invalid_template",
      "my_line_id"
    ]).has(command?.kind)) {
      return null;
    }
    if (command.kind === "my_line_id") {
      return {
        type: "text",
        text: `LINE User ID ของคุณ:\n${userId}\n\nใช้ค่านี้เฉพาะใน Render secret TIKTOK_OAUTH_ADMIN_LINE_USER_IDS`
      };
    }
    const clients = this.#authorizedLineControlClients(userId);
    if (clients.length === 0) return this.#lineControlPairingRequiredMessage();
    if (command.kind === "invalid_template") {
      return this.#invalidControlTemplateMessage(command.template);
    }
    if (command.kind === "agency_menu") {
      return buildAgencyControlMenuMessage({ clients });
    }
    if (command.kind === "agency_report") {
      return buildAgencyPerformanceReportMessage({
        entries: this.#agencySnapshotEntries(clients),
        now: this.now(),
        page: command.page ?? 1
      });
    }
    if (command.section === "close") {
      const activeEntries = this.#agencySnapshotEntries(clients)
        .filter(({ snapshot }) => snapshot?.campaignStatus === "ACTIVE");
      return buildCampaignPauseChoicesMessage({
        entries: activeEntries,
        now: this.now(),
        page: command.page ?? 1
      });
    }
    if (new Set(["create", "adjust", "auto_boost"]).has(command.section)) {
      return buildAgencyClientPickerMessage({
        clients,
        section: command.section,
        page: command.page ?? 1
      });
    }
    throw new DomainError("CONTROL_SECTION_UNSUPPORTED", "เมนูส่วนนี้ยังไม่รองรับ");
  }

  #controlFallbackMessage(userId) {
    const clients = this.#authorizedLineControlClients(userId);
    return clients.length > 0
      ? buildAgencyControlMenuMessage({ clients })
      : this.#lineControlPairingRequiredMessage();
  }

  #selectedControlPageMessage(command, client) {
    if (command.kind === "campaign_create_template") {
      return buildCampaignCreateTemplateMessage({
        client,
        shortcuts: this.store.listCampaignShortcuts({ clientId: client.id })
      });
    }
    if (command.kind === "campaign_close_menu") {
      const entry = { client, ...this.#latestControlSnapshot(client) };
      return buildCampaignPauseChoicesMessage({
        entries: entry.snapshot?.campaignStatus === "ACTIVE" ? [entry] : [],
        now: this.now()
      });
    }
    if (command.kind === "campaign_adjust_menu") {
      const { snapshot, stale } = this.#latestControlSnapshot(client);
      return buildCampaignAdjustmentMessage({ client, snapshot, stale, now: this.now() });
    }
    if (command.kind === "auto_boost_setup") {
      this.#autoBoostPolicy(client);
      const profile = this.store.getAutoBoostProfile({ clientId: client.id });
      if (profile) return this.#autoBoostStatusMessage(client, profile);
      const { snapshot, stale } = this.#latestControlSnapshot(client);
      return buildAutoBoostSetupTemplateMessage({ client, snapshot, stale, now: this.now() });
    }
    return null;
  }

  #lineControlClient(alias, userId) {
    const key = String(alias ?? "").toLocaleLowerCase("th-TH");
    const matches = this.config.clients.filter((client) => {
      if (client.lineControl?.enabled !== true) return false;
      const names = [client.id, client.name, ...(client.lineControl.aliases ?? [])];
      return names.some((name) => String(name).toLocaleLowerCase("th-TH") === key);
    });
    if (matches.length !== 1) {
      throw new DomainError(
        matches.length === 0 ? "CLIENT_NOT_FOUND" : "CLIENT_ALIAS_AMBIGUOUS",
        matches.length === 0
          ? "ไม่พบลูกค้าจากชื่อที่ระบุ กรุณาใช้ชื่อจากเมนู"
          : "ชื่อลูกค้านี้ตรงมากกว่าหนึ่งบัญชี กรุณาใช้ Client ID"
      );
    }
    const [client] = matches;
    if (!this.#isCurrentApprover(client, userId)) {
      throw new DomainError("LINE_NOT_AUTHORIZED", "LINE นี้ไม่มีสิทธิ์ควบคุมบัญชีลูกค้านี้");
    }
    return client;
  }

  #latestControlSnapshot(client) {
    const snapshot = this.store.getLatestTelemetry({ clientId: client.id });
    if (!snapshot) return { snapshot: null, stale: true };
    const age = this.now().getTime() - Date.parse(snapshot.observedAt);
    const activeCredential = typeof this.store.isTelemetrySnapshotCredentialActive !== "function"
      || this.store.isTelemetrySnapshotCredentialActive(snapshot.snapshotId) !== false;
    return {
      snapshot,
      stale: !activeCredential
        || !Number.isFinite(age)
        || age < -60_000
        || age > client.telemetry.maxSnapshotAgeSeconds * 1000
    };
  }

  #validateControlBudget(client, amount) {
    const minimum = client.lineControl.minDailyBudget;
    const maximum = client.budgetPolicy.maxDailyBudget;
    if (!Number.isFinite(amount) || amount < minimum || amount > maximum) {
      throw new DomainError(
        "BUDGET_OUT_OF_POLICY",
        `งบต้องอยู่ระหว่าง ${minimum} และ ${maximum} THB`
      );
    }
    return toMinor(amount, client.campaignSelector.currency);
  }

  #validateControlRoi(client, value) {
    if (
      !Number.isFinite(value)
      || value < client.lineControl.minTargetRoi
      || value > client.lineControl.maxTargetRoi
    ) {
      throw new DomainError(
        "ROI_OUT_OF_POLICY",
        `Target ROI ต้องอยู่ระหว่าง ${client.lineControl.minTargetRoi} และ ${client.lineControl.maxTargetRoi}`
      );
    }
    return Math.round(value * 1000);
  }

  #validateTopUpThreshold(client, percent) {
    if (
      !Number.isFinite(percent)
      || percent < client.lineControl.minTopUpThresholdPercent
      || percent > client.lineControl.maxTopUpThresholdPercent
    ) {
      throw new DomainError(
        "THRESHOLD_OUT_OF_POLICY",
        `เปอร์เซ็นต์เติมงบต้องอยู่ระหว่าง ${client.lineControl.minTopUpThresholdPercent}% และ ${client.lineControl.maxTopUpThresholdPercent}%`
      );
    }
    return Math.round(percent * 100);
  }

  #validateCampaignNameTemplate(client, template) {
    const normalized = String(template ?? "").normalize("NFKC").trim();
    if (
      client.telemetry?.source === "chrome-ui"
      && normalized !== "{date} {start}:00"
    ) {
      throw new DomainError(
        "CAMPAIGN_NAME_TEMPLATE_UNSUPPORTED",
        "ช่วงที่ใช้ Chrome reader ชื่อแคมเปญต้องเป็น {date} {start}:00 ก่อน หลังเชื่อม API จึงจะเปิดใช้ชื่ออิสระได้"
      );
    }
    return normalized;
  }

  #autoBoostPolicy(client) {
    if (client.lineControl?.enabled !== true) {
      throw new DomainError(
        "LINE_CONTROLS_DISABLED",
        `ระบบควบคุมผ่าน LINE ของ ${client.name} ถูกปิดอยู่`
      );
    }
    const policy = client.lineControl?.autoBoost;
    if (!policy || policy.enabled !== true) {
      throw new DomainError(
        "AUTO_BOOST_DISABLED",
        `Auto Boost ยังไม่ได้เปิดใช้งานในนโยบายของ ${client.name}`
      );
    }
    if (client.timezone !== "Asia/Bangkok") {
      throw new DomainError(
        "AUTO_BOOST_TIMEZONE_UNSUPPORTED",
        "Auto Boost รุ่น Pilot รองรับเขตเวลา Asia/Bangkok เท่านั้น"
      );
    }
    return policy;
  }

  #autoBoostCommandContext(event, eventId) {
    const sourceEventId = String(eventId ?? webhookEventId(event));
    const durableEvent = this.store.getWebhookEvent("LINE", sourceEventId);
    if (!Number.isSafeInteger(durableEvent?.sequence) || durableEvent.sequence < 1) {
      throw new DomainError(
        "AUTO_BOOST_COMMAND_NOT_DURABLE",
        "คำสั่ง Auto Boost ยังไม่ได้ถูกบันทึกอย่างปลอดภัย กรุณาส่งใหม่"
      );
    }
    const timestamp = durableEvent.payload?.timestamp;
    return {
      sourceEventId,
      commandSequence: durableEvent.sequence,
      commandTimestampMs: Number.isSafeInteger(timestamp) && timestamp >= 0
        ? timestamp
        : null
    };
  }

  #prepareAutoBoostProfile(client, command) {
    const policy = this.#autoBoostPolicy(client);
    if (command.boostPercent !== policy.boostPercent) {
      throw new DomainError(
        "AUTO_BOOST_PERCENT_OUT_OF_POLICY",
        `Pilot นี้กำหนดให้เพิ่มจากงบฐาน ${policy.boostPercent}% เท่านั้น`
      );
    }
    if (command.leadMinutes !== policy.leadMinutes) {
      throw new DomainError(
        "AUTO_BOOST_LEAD_OUT_OF_POLICY",
        `Pilot นี้กำหนดให้เริ่มก่อน ${policy.leadMinutes} นาทีเท่านั้น`
      );
    }
    if (command.windows.length > policy.maxWindows) {
      throw new DomainError(
        "AUTO_BOOST_TOO_MANY_WINDOWS",
        `ตั้งช่วงเวลาได้ไม่เกิน ${policy.maxWindows} ช่วงต่อวัน`
      );
    }

    let normalized;
    try {
      normalized = validateAutoBoostWindows(command.windows);
    } catch (error) {
      throw new DomainError("AUTO_BOOST_INVALID_WINDOWS", error.message);
    }
    const liveStart = timeMinutes(client.liveWindow.start);
    const liveEnd = timeMinutes(client.liveWindow.end);
    if (liveStart >= liveEnd) {
      throw new DomainError(
        "AUTO_BOOST_LIVE_WINDOW_UNSUPPORTED",
        "Auto Boost รุ่น Pilot ยังไม่รองรับ LIVE ที่ข้ามวัน"
      );
    }
    for (const window of normalized) {
      if (window.startMinute < liveStart || window.endMinute > liveEnd) {
        throw new DomainError(
          "AUTO_BOOST_OUTSIDE_LIVE_WINDOW",
          `ช่วงเวลา Auto Boost ต้องอยู่ภายในเวลา LIVE ${client.liveWindow.start}–${client.liveWindow.end}`
        );
      }
      if (window.startMinute < command.leadMinutes) {
        throw new DomainError(
          "AUTO_BOOST_PREVIOUS_DAY_UNSUPPORTED",
          "Auto Boost รุ่น Pilot ยังไม่รองรับเวลาเริ่มที่ทำให้ช่วงล่วงหน้าข้ามไปวันก่อน"
        );
      }
    }

    const baseBudgetMinor = this.#validateControlBudget(client, command.baseBudget);
    const boostBps = percentToBasisPoints(command.boostPercent);
    const targetBudgetMinor = calculateAutoBoostTargetMinor(baseBudgetMinor, boostBps);
    const policyCapMinor = toMinor(
      client.budgetPolicy.maxDailyBudget,
      client.campaignSelector.currency
    );
    if (targetBudgetMinor > policyCapMinor) {
      throw new DomainError(
        "AUTO_BOOST_POLICY_CAP_EXCEEDED",
        `งบช่วงพิเศษเกินเพดาน ${client.budgetPolicy.maxDailyBudget} THB กรุณาลดงบฐาน`
      );
    }
    const originalWindows = normalized.map(({ start, end }) => ({ start, end }));
    const mergedWindows = mergeEffectiveIntervals(originalWindows, command.leadMinutes);
    return {
      baseBudgetMinor,
      targetBudgetMinor,
      policyCapMinor,
      boostBps,
      leadMinutes: command.leadMinutes,
      originalWindows,
      mergedWindows
    };
  }

  #assertAutoBoostProfileCurrent(client, profile) {
    const policy = this.#autoBoostPolicy(client);
    const policyCapMinor = toMinor(
      client.budgetPolicy.maxDailyBudget,
      client.campaignSelector.currency
    );
    const expectedBoostBps = percentToBasisPoints(policy.boostPercent);
    const expectedTargetMinor = calculateAutoBoostTargetMinor(
      profile.baseBudgetMinor,
      expectedBoostBps
    );
    let normalizedWindows = [];
    try {
      normalizedWindows = validateAutoBoostWindows(profile.originalWindows);
    } catch {
      normalizedWindows = [];
    }
    const liveStart = timeMinutes(client.liveWindow.start);
    const liveEnd = timeMinutes(client.liveWindow.end);
    const windowsMatchPolicy = normalizedWindows.length === profile.originalWindows.length
      && liveStart < liveEnd
      && normalizedWindows.every((window) =>
        window.startMinute >= liveStart
        && window.endMinute <= liveEnd
        && window.startMinute >= profile.leadMinutes
      );
    const expectedMergedWindows = windowsMatchPolicy
      ? mergeEffectiveIntervals(profile.originalWindows, profile.leadMinutes)
      : [];
    if (
      profile.executionMode !== "DRY_RUN"
      || profile.boostBps !== expectedBoostBps
      || profile.leadMinutes !== policy.leadMinutes
      || profile.originalWindows.length > policy.maxWindows
      || profile.policyCapMinor !== policyCapMinor
      || profile.baseBudgetMinor < toMinor(
        client.lineControl.minDailyBudget,
        client.campaignSelector.currency
      )
      || profile.targetBudgetMinor !== expectedTargetMinor
      || profile.targetBudgetMinor > policyCapMinor
      || !windowsMatchPolicy
      || JSON.stringify(profile.mergedWindows) !== JSON.stringify(expectedMergedWindows)
    ) {
      throw new DomainError(
        "AUTO_BOOST_POLICY_CHANGED",
        "นโยบาย Auto Boost เปลี่ยนแล้ว กรุณาปิดและส่งตาราง Auto Boost ใหม่"
      );
    }
    if (!this.#isCurrentApprover(client, profile.ownerLineUserId)) {
      throw new DomainError(
        "LINE_NOT_AUTHORIZED",
        "ผู้ตั้ง Auto Boost ไม่ได้เป็นผู้อนุมัติของบัญชีนี้แล้ว"
      );
    }
    return profile;
  }

  #materializeAutoBoostToday(client, profile, at = this.now()) {
    this.#assertAutoBoostProfileCurrent(client, profile);
    if (!profile.enabled) return [];
    const localDate = bangkokLocalDate(at);
    const intervals = buildBangkokDailyIntervals({
      localDate,
      windows: profile.originalWindows,
      leadMinutes: profile.leadMinutes
    });
    return this.store.materializeAutoBoostOccurrences({
      clientId: client.id,
      localDate,
      intervals,
      now: at,
      deadlineMinutes: profile.leadMinutes
    });
  }

  #autoBoostStatusMessage(client, profile) {
    const nowMs = this.now().getTime();
    const occurrences = profile.activationGeneration > 0
      ? this.store.listAutoBoostOccurrences({
          clientId: client.id,
          revision: profile.revision,
          activationGeneration: profile.activationGeneration,
          limit: 1_000
        })
      : [];
    const nextAction = occurrences.find((item) => {
      const matchingBoost = item.phase === "RESTORE"
        ? occurrences.find((candidate) =>
            candidate.phase === "BOOST" && candidate.blockIndex === item.blockIndex
          )
        : null;
      const requiredRestore = item.phase === "RESTORE"
        && new Set(["PROCESSING", "DRY_RUN_COMPLETED", "OUTCOME_UNKNOWN"])
          .has(matchingBoost?.status);
      return (
          new Set(["PENDING", "PROCESSING"]).has(item.status)
          && (Date.parse(item.deadlineAt) >= nowMs || requiredRestore)
          && (profile.enabled || item.phase === "RESTORE")
      );
    });
    return buildAutoBoostStatusMessage({ client, plan: profile, nextAction });
  }

  #createControlRequest({ client, userId, action, desired, before = null, source = "LINE", requestId = null }) {
    const now = this.now();
    const id = requestId ?? newControlRequestId();
    const existing = this.store.getCampaignControlRequest(id);
    if (existing) {
      if (existing.clientId !== client.id || existing.action !== action) {
        throw new DomainError("CONTROL_REQUEST_CONFLICT", "Webhook identifier was reused for another command");
      }
      return existing;
    }
    return this.store.createCampaignControlRequest({
      id,
      clientId: client.id,
      action,
      requestedByLineUserId: userId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.config.requestTtlMinutes * 60_000),
      data: {
        clientName: client.name,
        advertiserId: client.advertiserId,
        tiktokAccountId: client.campaignSelector.expectedTikTokAccountId,
        currency: client.campaignSelector.currency,
        source,
        // Keep every new campaign-control action fail-closed until its official
        // TikTok executor and read-back reconciliation are implemented.
        dryRun: true,
        before,
        desired
      }
    });
  }

  #beforeFromSnapshot(snapshot, stale = false) {
    if (!snapshot) return null;
    return {
      campaignName: snapshot.campaignName,
      campaignRef: snapshot.campaignRef,
      campaignStatus: snapshot.campaignStatus,
      dailyBudgetMinor: snapshot.dailyBudgetMinor,
      observedAt: snapshot.observedAt,
      stale
    };
  }

  #requestForControlCommand(client, userId, command, requestId = null) {
    const { snapshot, stale } = this.#latestControlSnapshot(client);
    const before = this.#beforeFromSnapshot(snapshot, stale);
    if (command.action === "CREATE_FROM_SHORTCUT") {
      const shortcut = this.store.getCampaignShortcut({
        clientId: client.id,
        shortcutName: command.shortcutName
      });
      if (!shortcut) throw new DomainError("SHORTCUT_NOT_FOUND", "ไม่พบ Shortcut ที่ระบุ");
      const campaignNameTemplate = this.#validateCampaignNameTemplate(
        client,
        shortcut.campaignNameTemplate
      );
      const desired = {
        shortcutName: shortcut.shortcutName,
        shortcutRevision: shortcut.revision,
        campaignName: renderCampaignNameTemplate(campaignNameTemplate, this.now(), client),
        campaignNameTemplate,
        dailyBudgetMinor: shortcut.dailyBudgetMinor,
        targetRoiMilli: shortcut.targetRoiMilli,
        topUpThresholdBps: shortcut.topUpThresholdBps,
        scheduleStart: client.liveWindow.start,
        scheduleEnd: client.liveWindow.end
      };
      return this.#createControlRequest({
        client,
        userId,
        action: "CREATE_FROM_SHORTCUT",
        desired,
        before,
        source: "LINE_SHORTCUT",
        requestId
      });
    }
    if (command.action === "UPDATE_BUDGET") {
      if (!snapshot) throw new DomainError("TELEMETRY_UNAVAILABLE", "ยังไม่มีข้อมูลแคมเปญจาก Chrome reader");
      if (stale) {
        throw new DomainError("TELEMETRY_STALE", "ข้อมูลจาก Chrome reader เก่าเกินไป กรุณารอข้อมูลล่าสุดก่อนปรับงบ");
      }
      return this.#createControlRequest({
        client,
        userId,
        action: command.action,
        before,
        desired: { dailyBudgetMinor: this.#validateControlBudget(client, command.amount) },
        requestId
      });
    }
    if (command.action === "ADJUST_BUDGET") {
      if (!snapshot) {
        throw new DomainError("TELEMETRY_UNAVAILABLE", "ยังไม่มีข้อมูลแคมเปญจาก Chrome reader");
      }
      if (stale) {
        throw new DomainError(
          "TELEMETRY_STALE",
          "ข้อมูลจาก Chrome reader เก่าเกินไป กรุณารอข้อมูลล่าสุดก่อนปรับงบ"
        );
      }
      const direction = command.direction === -1 ? -1 : command.direction === 1 ? 1 : 0;
      if (direction === 0) {
        throw new DomainError("INVALID_REQUEST", "ทิศทางการปรับงบไม่ถูกต้อง");
      }
      const deltaMinor = toMinor(command.amount, client.campaignSelector.currency) * direction;
      const targetMinor = snapshot.dailyBudgetMinor + deltaMinor;
      const validatedTargetMinor = this.#validateControlBudget(
        client,
        fromMinor(targetMinor, client.campaignSelector.currency)
      );
      return this.#createControlRequest({
        client,
        userId,
        action: command.action,
        before,
        desired: {
          dailyBudgetMinor: validatedTargetMinor,
          budgetDeltaMinor: deltaMinor
        },
        requestId
      });
    }
    if (command.action === "UPDATE_ROI") {
      if (!snapshot) throw new DomainError("TELEMETRY_UNAVAILABLE", "ยังไม่มีข้อมูลแคมเปญจาก Chrome reader");
      if (stale) {
        throw new DomainError("TELEMETRY_STALE", "ข้อมูลจาก Chrome reader เก่าเกินไป กรุณารอข้อมูลล่าสุดก่อนปรับ ROI");
      }
      return this.#createControlRequest({
        client,
        userId,
        action: command.action,
        before,
        desired: { targetRoiMilli: this.#validateControlRoi(client, command.targetRoi) },
        requestId
      });
    }
    if (new Set(["PAUSE", "RESUME"]).has(command.action)) {
      if (!snapshot) throw new DomainError("TELEMETRY_UNAVAILABLE", "ยังไม่มีข้อมูลแคมเปญจาก Chrome reader");
      if (stale) {
        throw new DomainError("TELEMETRY_STALE", "ข้อมูลจาก Chrome reader เก่าเกินไป กรุณารอข้อมูลล่าสุดก่อนเปลี่ยนสถานะ");
      }
      return this.#createControlRequest({
        client,
        userId,
        action: command.action,
        before,
        desired: { campaignStatus: command.action === "PAUSE" ? "DISABLE" : "ENABLE" },
        requestId
      });
    }
    throw new DomainError("CONTROL_ACTION_UNSUPPORTED", "คำสั่งนี้ยังไม่รองรับ");
  }

  createLinePairing({ clientId, ttlMinutes = 10 } = {}) {
    const client = this.#clientById(clientId);
    if (!client) throw new DomainError("CLIENT_NOT_FOUND", "Client is not present in the approved config");
    if (client.linePairingEnabled !== true) {
      throw new DomainError("LINE_PAIRING_DISABLED", "LINE pairing is not enabled for this client");
    }
    if (!Number.isSafeInteger(ttlMinutes) || ttlMinutes < 2 || ttlMinutes > 60) {
      throw new DomainError("INVALID_REQUEST", "ttlMinutes must be an integer between 2 and 60");
    }
    const code = crypto.randomBytes(18).toString("base64url");
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + ttlMinutes * 60_000);
    const pairing = this.store.createLinePairing({
      clientId: client.id,
      codeHash: pairingCodeHash(client.id, code),
      createdAt,
      expiresAt
    });
    return Object.freeze({
      clientId: client.id,
      code,
      command: `จับคู่ ${client.id} ${code}`,
      expiresAt: pairing.expiresAt
    });
  }

  #view(request) {
    const suggestedMinor = request.targetBudgetMinor ?? request.metadata.suggestedTargetMinor;
    return {
      id: request.id,
      version: request.version,
      shortCode: requestCodeFor(request.id),
      clientName: request.metadata.clientName,
      campaignName: request.metadata.campaignName,
      advertiserId: request.adAccountId,
      currency: request.currency,
      timezone: request.metadata.timezone,
      currentBudget: fromMinor(request.currentBudgetMinor, request.currency),
      proposedBudget: fromMinor(suggestedMinor, request.currency),
      maxBudget: fromMinor(request.guardrails.maxBudgetMinor, request.currency),
      presetLabel: request.metadata.presetLabel ?? "ใช้งบแนะนำ",
      allowManualTarget: allowsManualTarget(request),
      telemetryOnly: request.metadata.telemetryOnly === true,
      dryRun: request.metadata.dryRun === true,
      spend: request.metadata.spendMinor == null ? null : fromMinor(request.metadata.spendMinor, request.currency),
      expiresAt: request.expiresAt
    };
  }

  #findMapping(adAccountId, campaignId) {
    for (const client of this.config.clients) {
      if (String(client.advertiserId) !== String(adAccountId)) continue;
      const campaign = (client.campaigns ?? []).find((item) => String(item.id) === String(campaignId));
      if (campaign) return { client, campaign };
    }
    return null;
  }

  #dynamicCampaign(client, info, policyLocalDate) {
    return {
      id: String(info.campaignId),
      name: info.campaignName || `${policyLocalDate} ${client.liveWindow.start}:00`,
      currency: client.campaignSelector.currency,
      maxDailyBudget: client.budgetPolicy.maxDailyBudget,
      dynamicPolicy: dynamicAuthoritySnapshot(client, policyLocalDate)
    };
  }

  #assertDynamicPolicyAvailable(client, at = this.now()) {
    const policyLocalDate = localDateFor(at, client.timezone);
    if (policyLocalDate < client.budgetPolicy.effectiveFrom) {
      throw new DomainError("NO_EFFECTIVE_BUDGET_POLICY", "The approved budget policy is not effective yet", {
        policyLocalDate,
        effectiveFrom: client.budgetPolicy.effectiveFrom
      });
    }
    if (!isWithinLiveWindow(at, client.timezone, client.liveWindow)) {
      throw new DomainError("OUTSIDE_LIVE_WINDOW", "The client is outside its approved LIVE monitoring window", {
        policyLocalDate,
        liveWindow: client.liveWindow
      });
    }
    return policyLocalDate;
  }

  async #resolveDynamicCampaign(client, { requireEnabled = true } = {}) {
    const policyLocalDate = this.#assertDynamicPolicyAvailable(client);
    const expectedName = `${policyLocalDate} ${client.liveWindow.start}:00`;
    const listed = await this.tiktok.getLiveCampaigns({
      advertiserId: client.advertiserId,
      storeId: client.storeId
    });
    const namedCandidates = listed.filter((item) => String(item?.campaign_name ?? "") === expectedName);
    const resolved = [];
    for (const candidate of namedCandidates) {
      if (typeof candidate?.campaign_id !== "string" || candidate.campaign_id === "") {
        throw new DomainError("TIKTOK_MALFORMED_CAMPAIGN_LIST", "A daily LIVE campaign omitted campaign_id");
      }
      const provisional = {
        id: String(candidate.campaign_id),
        expectedTikTokAccountId: client.campaignSelector.expectedTikTokAccountId
      };
      const info = await this.tiktok.getCampaignInfo({
        advertiserId: client.advertiserId,
        campaignId: provisional.id
      });
      this.#assertCampaignIdentity(info, client, provisional, { requireEnabled: false });
      if (String(info.campaignName ?? "") !== expectedName) {
        throw new DomainError("DYNAMIC_CAMPAIGN_NAME_MISMATCH", "TikTok campaign details do not match the selected daily campaign name");
      }
      if (info.operationStatus === "ENABLE") resolved.push(info);
    }
    if (resolved.length === 0) {
      throw new DomainError("DYNAMIC_CAMPAIGN_NOT_FOUND", "No enabled LIVE GMV Max campaign matched today's approved selector", {
        expectedName
      });
    }
    if (resolved.length !== 1) {
      throw new DomainError("DYNAMIC_CAMPAIGN_AMBIGUOUS", "More than one enabled LIVE GMV Max campaign matched today's approved selector", {
        expectedName,
        count: resolved.length
      });
    }
    const [info] = resolved;
    if (requireEnabled && info.operationStatus !== "ENABLE") {
      throw new DomainError("CAMPAIGN_NOT_ENABLED", "TikTok campaign is not enabled");
    }
    return { client, campaign: this.#dynamicCampaign(client, info, policyLocalDate), info, policyLocalDate };
  }

  #assertCampaignIdentity(info, client, campaign, { requireEnabled = true } = {}) {
    const checks = [
      [String(info?.advertiserId ?? ""), String(client.advertiserId), "ACCOUNT_MISMATCH", "TikTok advertiser does not match the configured client"],
      [String(info?.campaignId ?? ""), String(campaign.id), "CAMPAIGN_MISMATCH", "TikTok campaign does not match the configured campaign"],
      [String(info?.storeId ?? ""), String(client.storeId), "STORE_MISMATCH", "TikTok Shop does not match the configured client"],
      [
        String(info?.storeAuthorizedBcId ?? ""),
        String(client.storeAuthorizedBcId),
        "BUSINESS_CENTER_MISMATCH",
        "TikTok Shop authorization Business Center does not match the configured client"
      ],
      [String(info?.shoppingAdsType ?? ""), "LIVE", "NOT_LIVE_GMV_MAX", "Configured campaign is not LIVE GMV Max"]
    ];
    for (const [actual, expected, code, message] of checks) {
      if (actual !== expected) throw new DomainError(code, message, { expected, actual });
    }
    if (campaign.expectedTikTokAccountId) {
      const accountIds = dynamicAccountIds(info);
      if (accountIds.length === 0) {
        throw new DomainError(
          "TIKTOK_ACCOUNT_ID_UNVERIFIED",
          "TikTok campaign details did not expose the LIVE TikTok account identity"
        );
      }
      if (accountIds.length !== 1) {
        throw new DomainError(
          "TIKTOK_ACCOUNT_ID_AMBIGUOUS",
          "TikTok campaign details exposed more than one distinct LIVE TikTok account identity",
          {
            expected: String(campaign.expectedTikTokAccountId),
            actual: accountIds
          }
        );
      }
      if (accountIds[0] !== String(campaign.expectedTikTokAccountId)) {
        throw new DomainError("TIKTOK_ACCOUNT_MISMATCH", "TikTok LIVE account does not match the configured client", {
          expected: String(campaign.expectedTikTokAccountId),
          actual: accountIds
        });
      }
    }
    if (!Number.isFinite(info?.budget) || info.budget <= 0) {
      throw new DomainError("INVALID_TIKTOK_BUDGET", "TikTok returned an invalid campaign budget");
    }
    if (!new Set(["ENABLE", "DISABLE"]).has(info.operationStatus)) {
      throw new DomainError("INVALID_CAMPAIGN_STATUS", "TikTok returned an unknown campaign status");
    }
    if (requireEnabled && info.operationStatus !== "ENABLE") {
      throw new DomainError("CAMPAIGN_NOT_ENABLED", "TikTok campaign is not enabled");
    }
    return info;
  }

  #assertDynamicAuthorityUnchanged(snapshot, current) {
    const snapshotCanonical = canonicalDynamicAuthority(snapshot);
    const currentCanonical = canonicalDynamicAuthority(current);
    if (snapshotCanonical !== currentCanonical) {
      throw new DomainError(
        "BUDGET_POLICY_CHANGED",
        "The approved dynamic budget authority changed or crossed its local date",
        {
          snapshotDigest: dynamicAuthorityDigest(snapshotCanonical),
          currentDigest: dynamicAuthorityDigest(currentCanonical)
        }
      );
    }
  }

  #requestMapping(request) {
    if (telemetryOnlyRequest(request)) {
      throw new DomainError(
        "TELEMETRY_ONLY_REQUEST",
        "A telemetry dry-run request has no TikTok execution authority"
      );
    }
    const client = this.#clientById(request.clientId);
    if (!client || String(client.advertiserId) !== String(request.adAccountId)) {
      throw new DomainError("CONFIG_MAPPING_REVOKED", "The client/advertiser mapping is no longer approved");
    }
    if (client.campaignSelector) {
      if (request.metadata.dynamicCampaign !== true) {
        throw new DomainError("CONFIG_MAPPING_REVOKED", "The request is missing its dynamic campaign authority snapshot");
      }
      return {
        client,
        campaign: {
          id: String(request.campaignId),
          name: request.metadata.campaignName,
          currency: request.currency,
          maxDailyBudget: fromMinor(request.guardrails.maxBudgetMinor, request.currency),
          expectedTikTokAccountId: client.campaignSelector.expectedTikTokAccountId,
          dynamicPolicy: request.metadata.dynamicPolicy
        },
        dynamic: true
      };
    }
    const campaign = (client.campaigns ?? []).find((item) => String(item.id) === String(request.campaignId));
    if (!campaign) throw new DomainError("CONFIG_MAPPING_REVOKED", "The advertiser/campaign mapping is no longer approved");
    return { client, campaign, dynamic: false };
  }

  #currentExecutionMapping(request, userId) {
    const mapping = this.#requestMapping(request);
    if (!this.#isCurrentApprover(mapping.client, userId)) {
      throw new DomainError("APPROVER_REVOKED", "This LINE user is no longer an approved operator for the client");
    }
    if (
      String(mapping.client.storeId) !== String(request.metadata.storeId) ||
      String(mapping.client.storeAuthorizedBcId) !== String(request.metadata.storeAuthorizedBcId)
    ) {
      throw new DomainError("CONFIG_IDENTITY_CHANGED", "The configured Shop or Business Center changed after approval was requested");
    }
    if (mapping.dynamic) {
      const policyLocalDate = this.#assertDynamicPolicyAvailable(mapping.client);
      this.#assertDynamicAuthorityUnchanged(
        request.metadata.dynamicPolicy,
        dynamicAuthoritySnapshot(mapping.client, policyLocalDate)
      );
    }
    return mapping;
  }

  #createSnapshotRequest({ client, campaign, currentBudget, spend, proposedBudget }) {
    const currentBudgetMinor = toMinor(currentBudget, campaign.currency);
    const maxBudgetMinor = toMinor(campaign.maxDailyBudget, campaign.currency);
    const remainingToCeiling = maxBudgetMinor - currentBudgetMinor;
    let maxIncreaseMinor;
    let suggestedTargetMinor;
    if (campaign.dynamicPolicy) {
      const percentTargetMinor = Math.floor(
        currentBudgetMinor * (100 + campaign.dynamicPolicy.presetPercent) / 100
      );
      suggestedTargetMinor = Math.min(maxBudgetMinor, percentTargetMinor);
      maxIncreaseMinor = campaign.dynamicPolicy.allowManualTarget
        ? remainingToCeiling
        : suggestedTargetMinor - currentBudgetMinor;
    } else {
      // maxIncreasePercent is a hard ceiling. minIncrease affects the suggestion,
      // but must never widen the operator-approved percentage guardrail.
      const configuredDelta = Math.floor(currentBudgetMinor * (campaign.maxIncreasePercent / 100));
      maxIncreaseMinor = Math.min(remainingToCeiling, configuredDelta);
      const minIncreaseMinor = toMinor(campaign.minIncrease, campaign.currency);
      if (minIncreaseMinor > maxIncreaseMinor) {
        throw new DomainError("NO_SAFE_INCREASE", "Configured minimum increase does not fit under the hard percentage ceiling");
      }
      const requestedTargetMinor = toMinor(Math.min(proposedBudget, campaign.maxDailyBudget), campaign.currency);
      suggestedTargetMinor = Math.min(requestedTargetMinor, currentBudgetMinor + maxIncreaseMinor);
    }
    if (maxIncreaseMinor <= 0 || suggestedTargetMinor <= currentBudgetMinor) {
      throw new DomainError("NO_SAFE_INCREASE", "No increase is available within the configured guardrails");
    }

    const createdAt = this.now();
    const authorizedLineUserIds = this.#approversForClient(client);
    if (authorizedLineUserIds.length === 0) {
      throw new DomainError("NO_LINE_APPROVER", "No active LINE approver is paired for this client");
    }
    return createBudgetRequest({
      agencyId: this.config.agencyId ?? "agency",
      clientId: client.id,
      adAccountId: String(client.advertiserId),
      campaignId: String(campaign.id),
      authorizedLineUserIds,
      currency: campaign.currency,
      currentBudgetMinor,
      maxBudgetMinor,
      maxIncreaseMinor,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + this.config.requestTtlMinutes * 60_000),
      metadata: {
        clientName: client.name,
        campaignName: campaign.name,
        storeId: String(client.storeId),
        storeAuthorizedBcId: client.storeAuthorizedBcId,
        timezone: client.timezone,
        spendMinor: spend == null ? null : toMinor(spend, campaign.currency),
        suggestedTargetMinor,
        presetLabel: campaign.dynamicPolicy ? `เพิ่มงบ ${campaign.dynamicPolicy.presetPercent}%` : "ใช้งบแนะนำ",
        allowManualTarget: campaign.dynamicPolicy?.allowManualTarget ?? true,
        dynamicCampaign: Boolean(campaign.dynamicPolicy),
        dynamicPolicy: campaign.dynamicPolicy ?? null,
        source: "MONITOR"
      }
    });
  }

  async createAndSendRequest({ client, campaign, currentBudget, spend = null, proposedBudget, source = "MONITOR" }) {
    const value = this.#createSnapshotRequest({ client, campaign, currentBudget, spend, proposedBudget });
    const request = this.store.createBudgetRequest({
      ...value,
      metadata: { ...value.metadata, source }
    });
    await this.retryUndeliveredAlert(request);
    return request;
  }

  #deliveredApproverIndexes(request) {
    return new Set(this.store.listAuditEvents({ requestId: request.id, eventType: "LINE_ALERT_SENT", limit: 1000 })
      .map((event) => event.details.approverIndex)
      .filter(Number.isSafeInteger));
  }

  getAlertDeliveryStatus(request) {
    const delivered = this.#deliveredApproverIndexes(request).size;
    const total = request.authorizedLineUserIds.length;
    return {
      delivered,
      total,
      status: delivered === total ? "ALERT_DELIVERED" : delivered === 0 ? "ALERT_PENDING" : "ALERT_PARTIAL"
    };
  }

  async retryUndeliveredAlert(request) {
    if (request.state !== RequestState.PENDING_INPUT) return this.getAlertDeliveryStatus(request);
    const delivered = this.#deliveredApproverIndexes(request);
    const message = buildBudgetAlertMessage(this.#view(request));
    for (let index = 0; index < request.authorizedLineUserIds.length; index += 1) {
      if (delivered.has(index)) continue;
      const userId = request.authorizedLineUserIds[index];
      const retryKey = stableRetryKey("budget-alert", request.id, String(index));
      try {
        await this.line.push(userId, message, retryKey);
        delivered.add(index);
        this.store.appendAuditEvent({
          requestId: request.id,
          eventType: "LINE_ALERT_SENT",
          actorType: "SYSTEM",
          occurredAt: this.now(),
          details: { approverIndex: index, retryKey }
        });
      } catch (error) {
        this.store.appendAuditEvent({
          requestId: request.id,
          eventType: "LINE_ALERT_FAILED",
          actorType: "SYSTEM",
          occurredAt: this.now(),
          details: {
            approverIndex: index,
            retryKey,
            error: String(error?.message ?? error).slice(0, 500)
          }
        });
      }
    }
    const result = this.getAlertDeliveryStatus(request);
    if (result.status !== "ALERT_DELIVERED") {
      this.logger.error("LINE budget alert is not fully delivered", { requestId: request.id, ...result });
    }
    return result;
  }

  async retryPendingAlerts({ limit = 100 } = {}) {
    this.expireOldRequests();
    const outcomes = [];
    for (const request of this.store.listBudgetRequests({ state: RequestState.PENDING_INPUT, limit })) {
      const before = this.getAlertDeliveryStatus(request);
      if (before.status === "ALERT_DELIVERED") continue;
      const after = await this.retryUndeliveredAlert(request);
      outcomes.push({ requestId: request.id, before: before.status, after: after.status });
    }
    return outcomes;
  }

  #activeRequestFor(adAccountId, campaignId) {
    const latest = this.store.getLatestBudgetRequest({ adAccountId: String(adAccountId), campaignId: String(campaignId) });
    return latest && [RequestState.PENDING_INPUT, RequestState.PENDING_APPROVAL, RequestState.EXECUTING].includes(latest.state)
      ? latest
      : null;
  }

  #terminalReferenceBudgetMinor(request) {
    return request.state === RequestState.SUCCEEDED && request.result?.actualBudgetMinor != null
      ? request.result.actualBudgetMinor
      : request.currentBudgetMinor;
  }

  #latestTerminalRequest(adAccountId, campaignId) {
    const latest = this.store.getLatestBudgetRequest({
      adAccountId: String(adAccountId),
      campaignId: String(campaignId)
    });
    return latest && isTerminalState(latest.state) ? latest : null;
  }

  #cooldownUntil(adAccountId, campaignId, { observedBudgetMinor = null } = {}) {
    const latest = this.store.getLatestBudgetRequest({ adAccountId: String(adAccountId), campaignId: String(campaignId) });
    if (!latest || [RequestState.PENDING_INPUT, RequestState.PENDING_APPROVAL, RequestState.EXECUTING].includes(latest.state)) return null;
    if (
      observedBudgetMinor !== null
      && Number.isSafeInteger(observedBudgetMinor)
      && observedBudgetMinor !== this.#terminalReferenceBudgetMinor(latest)
    ) {
      return null;
    }
    return new Date(Date.parse(latest.updatedAt) + this.config.cooldownMinutes * 60_000);
  }

  async #notifyObservedBudgetChange({ request, snapshot, client }) {
    const referenceBudgetMinor = this.#terminalReferenceBudgetMinor(request);
    if (snapshot.dailyBudgetMinor === referenceBudgetMinor) return { delivered: 0, total: 0 };
    const sent = new Set(
      this.store.listAuditEvents({
        requestId: request.id,
        eventType: "LINE_BUDGET_CHANGE_SENT",
        limit: 1000
      })
        .filter((event) => event.details.observedBudgetMinor === snapshot.dailyBudgetMinor)
        .map((event) => event.details.approverIndex)
        .filter(Number.isSafeInteger)
    );
    let total = 0;
    for (let index = 0; index < request.authorizedLineUserIds.length; index += 1) {
      const userId = request.authorizedLineUserIds[index];
      if (!this.#isCurrentApprover(client, userId)) continue;
      total += 1;
      if (sent.has(index)) continue;
      const retryKey = stableRetryKey(
        "observed-budget-change",
        request.id,
        String(snapshot.dailyBudgetMinor),
        String(index)
      );
      try {
        await this.line.push(userId, buildObservedBudgetChangeMessage({
          clientName: request.metadata.clientName,
          campaignName: snapshot.campaignName,
          currency: snapshot.currency,
          previousBudget: fromMinor(referenceBudgetMinor, snapshot.currency),
          observedBudget: fromMinor(snapshot.dailyBudgetMinor, snapshot.currency),
          requestId: request.id,
          telemetryOnly: telemetryOnlyRequest(request)
        }), retryKey);
        sent.add(index);
        this.store.appendAuditEvent({
          requestId: request.id,
          eventType: "LINE_BUDGET_CHANGE_SENT",
          actorType: "SYSTEM",
          occurredAt: this.now(),
          details: {
            snapshotId: snapshot.snapshotId,
            observedBudgetMinor: snapshot.dailyBudgetMinor,
            referenceBudgetMinor,
            approverIndex: index,
            retryKey,
            telemetryOnly: telemetryOnlyRequest(request)
          }
        });
      } catch (error) {
        this.store.appendAuditEvent({
          requestId: request.id,
          eventType: "LINE_BUDGET_CHANGE_FAILED",
          actorType: "SYSTEM",
          occurredAt: this.now(),
          details: {
            snapshotId: snapshot.snapshotId,
            observedBudgetMinor: snapshot.dailyBudgetMinor,
            referenceBudgetMinor,
            approverIndex: index,
            retryKey,
            error: String(error?.message ?? error).slice(0, 500)
          }
        });
      }
    }
    return { delivered: sent.size, total };
  }

  async processTelemetrySnapshotForDryRunAlert({ snapshot, latest = true } = {}) {
    const skip = (status, details = {}) => ({
      clientId: snapshot?.clientId ?? null,
      snapshotId: snapshot?.snapshotId ?? null,
      status,
      ...details
    });
    if (!this.telemetryAlertsEnabled) return skip("SKIP_TELEMETRY_ALERTS_DISABLED");
    if (latest !== true) return skip("SKIP_NOT_LATEST");
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      return skip("SKIP_INVALID_SNAPSHOT");
    }
    const expectedTelemetryFingerprint = snapshot.schemaVersion === 1
      ? TELEMETRY_UI_SCHEMA_FINGERPRINT_V1
      : snapshot.schemaVersion === 2
        ? TELEMETRY_UI_SCHEMA_FINGERPRINT_V2
        : null;
    if (!expectedTelemetryFingerprint || snapshot.uiSchemaFingerprint !== expectedTelemetryFingerprint) {
      return skip("SKIP_TELEMETRY_SCHEMA_MISMATCH");
    }
    if (
      typeof this.store.isTelemetrySnapshotCredentialActive === "function"
      && this.store.isTelemetrySnapshotCredentialActive(snapshot.snapshotId) === false
    ) {
      return skip("SKIP_REVOKED_TELEMETRY_CREDENTIAL");
    }

    const client = this.#clientById(snapshot.clientId);
    if (!client || client.telemetry?.source !== "chrome-ui" || !client.campaignSelector) {
      return skip("SKIP_CLIENT_BINDING_MISMATCH");
    }
    const exactBindings = [
      [snapshot.advertiserId, client.advertiserId],
      [snapshot.businessCenterId, client.telemetry.businessCenterId],
      [snapshot.sellerMode, client.telemetry.sellerMode],
      [snapshot.pageType, client.telemetry.pageType],
      [snapshot.tiktokAccountId, client.campaignSelector.expectedTikTokAccountId],
      [snapshot.source?.browserProfile, client.telemetry.browserProfile],
      [snapshot.source?.tabGroup, client.telemetry.tabGroup],
      [snapshot.campaignType, "LIVE_GMV_MAX"],
      [snapshot.campaignStatus, "ACTIVE"],
      [snapshot.currency, client.campaignSelector.currency]
    ];
    if (exactBindings.some(([actual, expected]) => actual !== expected)) {
      return skip("SKIP_CLIENT_BINDING_MISMATCH");
    }
    if (snapshot.campaignId !== null) return skip("SKIP_OBSERVED_CAMPAIGN_ID_PRESENT");

    const observedAt = new Date(snapshot.observedAt);
    const now = this.now();
    if (Number.isNaN(observedAt.getTime()) || Number.isNaN(now.getTime())) {
      return skip("SKIP_INVALID_OBSERVATION_TIME");
    }
    const ageMilliseconds = now.getTime() - observedAt.getTime();
    if (
      ageMilliseconds < -60_000
      || ageMilliseconds > client.telemetry.maxSnapshotAgeSeconds * 1000
    ) {
      return skip("SKIP_STALE_SNAPSHOT");
    }

    const policyLocalDate = localDateFor(now, client.timezone);
    const observedLocalDate = localDateFor(observedAt, client.timezone);
    if (policyLocalDate !== observedLocalDate) return skip("SKIP_LOCAL_DATE_MISMATCH");
    if (
      !isWithinLiveWindow(now, client.timezone, client.liveWindow)
      || !isWithinLiveWindow(observedAt, client.timezone, client.liveWindow)
    ) {
      return skip("SKIP_OUTSIDE_LIVE_WINDOW");
    }
    if (policyLocalDate < client.budgetPolicy.effectiveFrom) {
      return skip("SKIP_POLICY_NOT_EFFECTIVE");
    }

    const expectedCampaignName = `${policyLocalDate} ${client.liveWindow.start}:00`;
    if (snapshot.campaignName !== expectedCampaignName) return skip("SKIP_CAMPAIGN_NAME_MISMATCH");
    const expectedCampaignRef = telemetryUiCampaignRef({
      advertiserId: String(client.advertiserId),
      campaignName: expectedCampaignName
    });
    if (snapshot.campaignRef !== expectedCampaignRef) return skip("SKIP_CAMPAIGN_REF_MISMATCH");

    const moneyFields = [
      snapshot.dailyBudgetMinor,
      snapshot.totalBudgetMinor,
      snapshot.costMinor,
      snapshot.netCostMinor
    ];
    if (
      moneyFields.some((value) => !Number.isSafeInteger(value) || value < 0)
      || snapshot.dailyBudgetMinor <= 0
      || snapshot.totalBudgetMinor <= 0
    ) {
      return skip("SKIP_INVALID_MONEY");
    }
    const capMinor = toMinor(client.budgetPolicy.maxDailyBudget, client.campaignSelector.currency);
    if (
      snapshot.policy?.maxDailyBudgetMinor !== capMinor
      || snapshot.policy?.overDailyBudgetCap === true
      || snapshot.dailyBudgetMinor > capMinor
    ) {
      return skip("SKIP_OVER_POLICY_CAP");
    }
    const latestTerminal = this.#latestTerminalRequest(client.advertiserId, snapshot.campaignRef);
    if (
      latestTerminal
      && snapshot.dailyBudgetMinor !== this.#terminalReferenceBudgetMinor(latestTerminal)
    ) {
      await this.#notifyObservedBudgetChange({ request: latestTerminal, snapshot, client });
    }
    if (snapshot.dailyBudgetMinor >= capMinor) return skip("SKIP_NO_SAFE_INCREASE");
    if (!thresholdReached(snapshot.costMinor, snapshot.dailyBudgetMinor, client.warningThreshold)) {
      return skip("BELOW_THRESHOLD", {
        costMinor: snapshot.costMinor,
        dailyBudgetMinor: snapshot.dailyBudgetMinor
      });
    }

    const active = this.#activeRequestFor(client.advertiserId, snapshot.campaignRef);
    if (active) return skip("SKIP_ACTIVE_REQUEST", { requestId: active.id });
    const cooldownUntil = this.#cooldownUntil(client.advertiserId, snapshot.campaignRef, {
      observedBudgetMinor: snapshot.dailyBudgetMinor
    });
    if (cooldownUntil && cooldownUntil.getTime() > now.getTime()) {
      return skip("SKIP_COOLDOWN", { cooldownUntil: cooldownUntil.toISOString() });
    }

    const campaign = {
      // This is a logical observation/dedupe key, never a TikTok campaign ID.
      id: snapshot.campaignRef,
      name: snapshot.campaignName,
      currency: client.campaignSelector.currency,
      maxDailyBudget: client.budgetPolicy.maxDailyBudget,
      dynamicPolicy: dynamicAuthoritySnapshot(client, policyLocalDate)
    };
    const currentBudget = fromMinor(snapshot.dailyBudgetMinor, snapshot.currency);
    const spend = fromMinor(snapshot.costMinor, snapshot.currency);
    const proposedBudget = fromMinor(
      Math.min(
        capMinor,
        Math.floor(snapshot.dailyBudgetMinor * (100 + client.budgetIncrease.presetPercent) / 100)
      ),
      snapshot.currency
    );
    const value = this.#createSnapshotRequest({
      client,
      campaign,
      currentBudget,
      spend,
      proposedBudget
    });
    let request;
    try {
      request = this.store.createBudgetRequest({
        ...value,
        metadata: {
          ...value.metadata,
          source: "CHROME_TELEMETRY_DRY_RUN",
          telemetryOnly: true,
          dryRun: true,
          executionMode: "APPROVAL_ONLY",
          observedCampaignId: null,
          campaignRef: snapshot.campaignRef,
          presetLabel: `ทดสอบเพิ่มงบ ${client.budgetIncrease.presetPercent}%`,
          storeId: null,
          storeAuthorizedBcId: null,
          telemetrySnapshot: {
            snapshotId: snapshot.snapshotId,
            observedAt: snapshot.observedAt,
            advertiserId: snapshot.advertiserId,
            businessCenterId: snapshot.businessCenterId,
            tiktokAccountId: snapshot.tiktokAccountId,
            browserProfile: snapshot.source.browserProfile,
            tabGroup: snapshot.source.tabGroup,
            dailyBudgetMinor: snapshot.dailyBudgetMinor,
            costMinor: snapshot.costMinor
          }
        }
      });
    } catch (error) {
      if (error?.code === "ACTIVE_REQUEST_EXISTS") {
        return skip("SKIP_ACTIVE_REQUEST");
      }
      throw error;
    }
    const delivery = await this.retryUndeliveredAlert(request);
    return skip(delivery.status, {
      requestId: request.id,
      utilization: snapshot.costMinor / snapshot.dailyBudgetMinor
    });
  }

  async processLatestTelemetryDryRunAlerts({ limit = 100 } = {}) {
    if (!this.telemetryAlertsEnabled) return [];
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new DomainError("INVALID_REQUEST", "limit must be an integer between 1 and 1000");
    }
    const outcomes = [];
    for (const snapshot of this.store.listLatestTelemetry({ limit })) {
      if (this.store.getTelemetryAlertEvaluation(snapshot.snapshotId)) continue;
      let outcome;
      try {
        outcome = await this.processTelemetrySnapshotForDryRunAlert({ snapshot, latest: true });
      } catch (error) {
        const safe = safeError(error);
        outcome = {
          clientId: snapshot.clientId,
          snapshotId: snapshot.snapshotId,
          status: "ERROR",
          errorCode: safe.code
        };
        this.logger.error("telemetry dry-run alert evaluation failed", {
          clientId: snapshot.clientId,
          snapshotId: snapshot.snapshotId,
          code: safe.code,
          message: safe.message
        });
      }
      this.store.recordTelemetryAlertEvaluation({
        snapshotId: snapshot.snapshotId,
        status: outcome.status,
        requestId: outcome.requestId ?? null,
        evaluatedAt: this.now(),
        details: {
          clientId: outcome.clientId,
          utilization: outcome.utilization ?? null,
          cooldownUntil: outcome.cooldownUntil ?? null,
          errorCode: outcome.errorCode ?? null
        }
      });
      outcomes.push(outcome);
    }
    return outcomes;
  }

  expireOldRequests() {
    const now = this.now();
    for (const state of [RequestState.PENDING_INPUT, RequestState.PENDING_APPROVAL]) {
      for (const request of this.store.listBudgetRequests({ state, limit: 1000 })) {
        if (Date.parse(request.expiresAt) <= now.getTime()) {
          try {
            this.store.expireBudgetRequest(request.id, { now });
          } catch (error) {
            if (error.code !== "CONCURRENT_MODIFICATION" && error.code !== "INVALID_STATE") throw error;
          }
        }
      }
    }
  }

  async validateConfiguredAccess() {
    const verified = [];
    for (const client of this.config.clients) {
      if (client.campaignSelector) {
        const listed = await this.tiktok.getLiveCampaigns({
          advertiserId: client.advertiserId,
          storeId: client.storeId
        });
        verified.push({
          clientId: client.id,
          advertiserId: String(client.advertiserId),
          dynamicCampaignCount: listed.length
        });
        continue;
      }
      for (const campaign of client.campaigns ?? []) {
        const info = await this.tiktok.getCampaignInfo({
          advertiserId: client.advertiserId,
          campaignId: campaign.id
        });
        this.#assertCampaignIdentity(info, client, campaign, { requireEnabled: false });
        verified.push({ clientId: client.id, advertiserId: String(client.advertiserId), campaignId: String(campaign.id) });
      }
    }
    return verified;
  }

  async #pollResolvedCampaign({ client, campaign, resolvedInfo = null }) {
    const activeRequest = this.#activeRequestFor(client.advertiserId, campaign.id);
    if (activeRequest) {
      if (activeRequest.state === RequestState.PENDING_INPUT) {
        const before = this.getAlertDeliveryStatus(activeRequest);
        if (before.status === "ALERT_DELIVERED") {
          return { clientId: client.id, campaignId: campaign.id, status: "SKIP_ACTIVE_REQUEST" };
        }
        const delivery = await this.retryUndeliveredAlert(activeRequest);
        return { clientId: client.id, campaignId: campaign.id, status: delivery.status, requestId: activeRequest.id };
      }
      return { clientId: client.id, campaignId: campaign.id, status: "SKIP_ACTIVE_REQUEST" };
    }
    const info = resolvedInfo ?? await this.tiktok.getCampaignInfo({
      advertiserId: client.advertiserId,
      campaignId: campaign.id
    });
    this.#assertCampaignIdentity(info, client, campaign, { requireEnabled: false });
    if (info.operationStatus !== "ENABLE") {
      return { clientId: client.id, campaignId: campaign.id, status: "SKIP_DISABLED" };
    }
    const cooldownUntil = this.#cooldownUntil(client.advertiserId, campaign.id, {
      observedBudgetMinor: toMinor(info.budget, campaign.currency)
    });
    if (cooldownUntil && cooldownUntil.getTime() > this.now().getTime()) {
      return {
        clientId: client.id,
        campaignId: campaign.id,
        status: "SKIP_COOLDOWN",
        cooldownUntil: cooldownUntil.toISOString()
      };
    }
    const spendResult = await this.tiktok.getTodayCampaignSpend({
      advertiserId: client.advertiserId,
      storeId: client.storeId,
      campaignId: campaign.id,
      timezone: client.timezone,
      now: this.now()
    });
    if (spendResult.currency && spendResult.currency !== campaign.currency) {
      throw new DomainError("REPORT_CURRENCY_MISMATCH", "TikTok report currency does not match the configured campaign currency");
    }
    const utilization = spendResult.spend / info.budget;
    const warningThreshold = client.warningThreshold ?? this.config.warningThreshold;
    if (utilization < warningThreshold) {
      return { clientId: client.id, campaignId: campaign.id, status: "BELOW_THRESHOLD", utilization };
    }
    const proposedBudget = calculateSuggestedTarget(info.budget, campaign);
    const request = await this.createAndSendRequest({
      client,
      campaign,
      currentBudget: info.budget,
      spend: spendResult.spend,
      proposedBudget,
      source: "MONITOR"
    });
    const delivery = this.getAlertDeliveryStatus(request);
    return { clientId: client.id, campaignId: campaign.id, status: delivery.status, requestId: request.id, utilization };
  }

  async pollOnce() {
    this.expireOldRequests();
    const outcomes = [];
    for (const client of this.config.clients) {
      if (client.campaignSelector) {
        try {
          const resolved = await this.#resolveDynamicCampaign(client);
          outcomes.push(await this.#pollResolvedCampaign({
            client,
            campaign: resolved.campaign,
            resolvedInfo: resolved.info
          }));
        } catch (error) {
          const safe = safeError(error);
          // Outside-window and not-yet-effective policies are expected idle
          // states. A missing daily campaign during the approved LIVE window
          // can leave the account unmonitored, so surface and log it as an
          // operator-visible error instead of silently skipping it.
          const skipCodes = new Set(["OUTSIDE_LIVE_WINDOW", "NO_EFFECTIVE_BUDGET_POLICY"]);
          outcomes.push({
            clientId: client.id,
            campaignId: null,
            status: skipCodes.has(safe.code) ? `SKIP_${safe.code}` : "ERROR",
            error: safe
          });
          if (!skipCodes.has(safe.code)) {
            this.logger.error("dynamic monitor error", { clientId: client.id, code: safe.code, message: safe.message });
          }
        }
        continue;
      }
      for (const campaign of client.campaigns ?? []) {
        try {
          outcomes.push(await this.#pollResolvedCampaign({ client, campaign }));
        } catch (error) {
          const safe = safeError(error);
          outcomes.push({ clientId: client.id, campaignId: campaign.id, status: "ERROR", error: safe });
          this.logger.error("monitor error", { clientId: client.id, campaignId: campaign.id, code: safe.code, message: safe.message });
        }
      }
    }
    return outcomes;
  }

  async createManualRequest({ advertiserId, campaignId, proposedBudget }) {
    let mapping = this.#findMapping(advertiserId, campaignId);
    let resolvedInfo = null;
    if (!mapping) {
      const dynamicClient = this.config.clients.find((client) =>
        client.campaignSelector && String(client.advertiserId) === String(advertiserId)
      );
      if (dynamicClient) {
        const resolved = await this.#resolveDynamicCampaign(dynamicClient);
        if (campaignId && String(campaignId) !== String(resolved.campaign.id)) {
          throw new DomainError("DYNAMIC_CAMPAIGN_CHANGED", "The supplied campaign is not today's resolved LIVE campaign");
        }
        mapping = { client: dynamicClient, campaign: resolved.campaign };
        resolvedInfo = resolved.info;
        campaignId = resolved.campaign.id;
      }
    }
    if (!mapping) throw new DomainError("MAPPING_NOT_FOUND", "Advertiser/campaign is not present in the approved config");
    if (this.#activeRequestFor(advertiserId, campaignId)) throw new DomainError("ACTIVE_REQUEST_EXISTS", "An active request already exists for this campaign");
    const info = resolvedInfo ?? await this.tiktok.getCampaignInfo({ advertiserId, campaignId });
    this.#assertCampaignIdentity(info, mapping.client, mapping.campaign);
    const cooldownUntil = this.#cooldownUntil(advertiserId, campaignId, {
      observedBudgetMinor: toMinor(info.budget, mapping.campaign.currency)
    });
    if (cooldownUntil && cooldownUntil.getTime() > this.now().getTime()) {
      throw new DomainError("COOLDOWN_ACTIVE", `Campaign is in cooldown until ${cooldownUntil.toISOString()}`);
    }
    const spendResult = await this.tiktok.getTodayCampaignSpend({
      advertiserId,
      storeId: mapping.client.storeId,
      campaignId,
      timezone: mapping.client.timezone,
      now: this.now()
    });
    return this.createAndSendRequest({
      ...mapping,
      currentBudget: info.budget,
      spend: spendResult.spend,
      proposedBudget,
      source: "ADMIN"
    });
  }

  async #replySafely(replyToken, message, requestId = null) {
    if (!replyToken) return;
    try {
      await this.line.reply(replyToken, message);
    } catch (error) {
      this.store.appendAuditEvent({
        requestId,
        eventType: "LINE_REPLY_FAILED",
        actorType: "SYSTEM",
        occurredAt: this.now(),
        details: { error: String(error?.message ?? error).slice(0, 500) }
      });
    }
  }

  async #replyControlDurably(replyToken, message) {
    if (!replyToken) return;
    try {
      await this.line.reply(replyToken, message);
    } catch (error) {
      this.store.appendAuditEvent({
        eventType: "LINE_CONTROL_REPLY_FAILED",
        actorType: "SYSTEM",
        occurredAt: this.now(),
        details: { error: String(error?.message ?? error).slice(0, 500) }
      });
      // A failed reply must leave the webhook recoverable. The durable webhook
      // worker will rebuild the response and push it with an idempotency key.
      throw new DomainError(
        "LINE_CONTROL_REPLY_FAILED",
        "LINE control response could not be delivered",
        { cause: String(error?.message ?? error).slice(0, 500) }
      );
    }
  }

  async #handlePairingCommand({ clientId, codeHash, userId, sourceType, replyToken }) {
    if (sourceType !== "user") {
      await this.#replySafely(replyToken, { type: "text", text: "กรุณาจับคู่ผู้อนุมัติในแชตส่วนตัวกับ LINE OA เท่านั้น" });
      return { paired: false, reason: "DIRECT_CHAT_REQUIRED" };
    }
    const client = this.#clientById(clientId);
    if (!client || client.linePairingEnabled !== true) {
      await this.#replySafely(replyToken, { type: "text", text: "จับคู่ไม่สำเร็จ กรุณาขอรหัสใหม่จากผู้ดูแลระบบ" });
      return { paired: false, reason: "PAIRING_UNAVAILABLE" };
    }
    if (this.store.isLineApprover({ clientId: client.id, lineUserId: userId })) {
      await this.#replySafely(replyToken, { type: "text", text: `LINE นี้เป็นผู้อนุมัติของ ${client.name} อยู่แล้ว` });
      return { paired: true, alreadyPaired: true, clientId: client.id };
    }
    try {
      this.store.consumeLinePairing({
        clientId: client.id,
        codeHash,
        lineUserId: userId,
        consumedAt: this.now()
      });
      await this.#replySafely(replyToken, {
        type: "text",
        text: `✅ จับคู่ผู้อนุมัติสำเร็จ\nลูกค้า: ${client.name}\nระบบจะส่งคำขอเพิ่มงบมาที่แชตนี้`
      });
      return { paired: true, alreadyPaired: false, clientId: client.id };
    } catch (error) {
      await this.#replySafely(replyToken, {
        type: "text",
        text: "จับคู่ไม่สำเร็จ รหัสอาจไม่ถูกต้อง หมดอายุ หรือถูกแทนที่แล้ว กรุณาขอรหัสใหม่"
      });
      return { paired: false, reason: error?.code ?? "PAIRING_FAILED" };
    }
  }

  async #handleControlCommand(event, userId, parsedCommand = null, eventId = null) {
    const command = parsedCommand ?? parseControlCommand(event.message?.text);
    if (event.source?.type && event.source.type !== "user") {
      await this.#replyControlDurably(event.replyToken, this.#privateChatOnlyMessage());
      return true;
    }
    if (!command) {
      await this.#replyControlDurably(event.replyToken, this.#controlFallbackMessage(userId));
      return true;
    }
    try {
      const agencyMessage = this.#agencyCommandMessage(command, userId);
      if (agencyMessage) {
        await this.#replyControlDurably(event.replyToken, agencyMessage);
        return true;
      }
      const client = this.#lineControlClient(command.clientAlias, userId);
      const selectedPageMessage = this.#selectedControlPageMessage(command, client);
      if (selectedPageMessage) {
        await this.#replyControlDurably(event.replyToken, selectedPageMessage);
        return true;
      }
      if (command.kind === "menu") {
        await this.#replyControlDurably(event.replyToken, buildControlMenuMessage(client));
        return true;
      }
      if (command.kind === "help") {
        await this.#replyControlDurably(event.replyToken, { type: "text", text: controlHelpText(client) });
        return true;
      }
      if (command.kind === "status") {
        const { snapshot, stale } = this.#latestControlSnapshot(client);
        await this.#replyControlDurably(event.replyToken, buildPerformanceReportMessage({
          client,
          snapshot,
          stale,
          now: this.now()
        }));
        return true;
      }
      if (command.kind === "tiktok_oauth_start") {
        if (!this.tiktokApiControl) {
          throw new DomainError(
            "TIKTOK_OAUTH_DISABLED",
            "ระบบเชื่อม TikTok API ยังไม่ได้เปิดบนเซิร์ฟเวอร์"
          );
        }
        const authorization = this.tiktokApiControl.createAuthorizationRequest({
          lineUserId: userId
        });
        await this.#replyControlDurably(event.replyToken, {
          type: "template",
          altText: `อนุญาต TikTok API สำหรับ ${client.name}`,
          template: {
            type: "buttons",
            title: "เชื่อม TikTok API",
            text: `กดเพื่ออนุญาต Agency account จาก TikTok\nลิงก์หมดอายุ ${new Date(authorization.expiresAt).toLocaleTimeString("th-TH", {
              timeZone: client.timezone,
              hour: "2-digit",
              minute: "2-digit"
            })}`,
            actions: [{
              type: "uri",
              label: "อนุญาตผ่าน TikTok",
              uri: authorization.url
            }]
          }
        });
        return true;
      }
      if (command.kind === "tiktok_api_preflight") {
        if (!this.tiktokApiControl) {
          throw new DomainError(
            "TIKTOK_API_DISABLED",
            "ระบบ TikTok API ยังไม่ได้เปิดบนเซิร์ฟเวอร์"
          );
        }
        const result = await this.tiktokApiControl.preflightClient(client);
        await this.#replyControlDurably(
          event.replyToken,
          buildTikTokPreflightMessage({ client, result })
        );
        return true;
      }
      if (command.kind === "auto_boost_status") {
        this.#autoBoostPolicy(client);
        const profile = this.store.getAutoBoostProfile({ clientId: client.id });
        await this.#replyControlDurably(
          event.replyToken,
          profile
            ? this.#autoBoostStatusMessage(client, profile)
            : {
                type: "text",
                text: `ยังไม่ได้ตั้ง Auto Boost ของ ${client.name}\nพิมพ์ “วิธีใช้ ${client.lineControl.aliases[0]}” เพื่อดูรูปแบบคำสั่ง`
              }
        );
        return true;
      }
      if (command.kind === "auto_boost_upsert") {
        const prepared = this.#prepareAutoBoostProfile(client, command);
        const commandContext = this.#autoBoostCommandContext(event, eventId);
        const profile = this.store.saveAutoBoostProfile({
          clientId: client.id,
          ...prepared,
          ...commandContext,
          ownerLineUserId: userId,
          executionMode: "DRY_RUN",
          now: this.now()
        });
        const applied = profile.lastCommandSequence === commandContext.commandSequence;
        await this.#replyControlDurably(event.replyToken, [
          {
            type: "text",
            text: applied
              ? "✅ บันทึกตาราง Auto Boost แล้ว โดยเริ่มต้นเป็น OFF กรุณาตรวจแล้วกดเปิดจากปุ่มด้านล่าง"
              : "ℹ️ ข้ามคำสั่ง Auto Boost เก่าแล้ว แสดงสถานะล่าสุดของระบบแทน"
          },
          this.#autoBoostStatusMessage(client, profile)
        ]);
        return true;
      }
      if (command.kind === "auto_boost_toggle") {
        const profile = this.store.getAutoBoostProfile({ clientId: client.id });
        if (!profile) {
          throw new DomainError(
            "AUTO_BOOST_PROFILE_NOT_FOUND",
            "ยังไม่มีตาราง Auto Boost กรุณาตั้งตารางก่อนเปิดใช้งาน"
          );
        }
        if (command.enabled) this.#assertAutoBoostProfileCurrent(client, profile);
        const commandContext = this.#autoBoostCommandContext(event, eventId);
        const updated = this.store.setAutoBoostEnabled({
          clientId: client.id,
          enabled: command.enabled,
          expectedRevision: profile.revision,
          lineUserId: userId,
          ...commandContext,
          now: this.now()
        });
        const applied = updated.lastCommandSequence === commandContext.commandSequence;
        if (applied && updated.enabled) this.#materializeAutoBoostToday(client, updated, this.now());
        await this.#replyControlDurably(event.replyToken, [
          {
            type: "text",
            text: !applied
              ? "ℹ️ ข้ามคำสั่ง Auto Boost เก่าแล้ว แสดงสถานะล่าสุดของระบบแทน"
              : updated.enabled
                ? `🟢 เปิด Auto Boost แล้ว ระบบจะจำลองเพิ่ม ${updated.boostBps / 100}% ก่อนแต่ละช่วง ${updated.leadMinutes} นาที และจำลองคืนงบเมื่อจบ`
                : "⚪ ปิด Auto Boost แล้ว ระบบยกเลิกรอบเพิ่มงบในอนาคต ส่วนรอบที่เริ่มแล้วจะยังจำลองคืนงบให้ครบ"
          },
          this.#autoBoostStatusMessage(client, updated)
        ]);
        return true;
      }
      if (command.kind === "report_subscribe") {
        if (
          command.intervalHours < client.lineControl.minReportIntervalHours
          || command.intervalHours > client.lineControl.maxReportIntervalHours
        ) {
          throw new DomainError(
            "REPORT_INTERVAL_OUT_OF_POLICY",
            `ตั้งรายงานได้ทุก ${client.lineControl.minReportIntervalHours}–${client.lineControl.maxReportIntervalHours} ชั่วโมง`
          );
        }
        const subscription = this.store.setReportSubscription({
          clientId: client.id,
          lineUserId: userId,
          intervalMinutes: command.intervalHours * 60,
          enabled: true,
          now: this.now()
        });
        const { snapshot, stale } = this.#latestControlSnapshot(client);
        await this.#replyControlDurably(event.replyToken, [
          {
            type: "text",
            text: `✅ ตั้งรายงาน ${client.name} ทุก ${command.intervalHours} ชั่วโมงแล้ว\nรอบถัดไป: ${new Date(subscription.nextDueAt).toLocaleString("th-TH", { timeZone: client.timezone, hour: "2-digit", minute: "2-digit" })}`
          },
          buildPerformanceReportMessage({ client, snapshot, stale, now: this.now() })
        ]);
        return true;
      }
      if (command.kind === "report_unsubscribe") {
        const disabled = this.store.disableReportSubscription({
          clientId: client.id,
          lineUserId: userId,
          now: this.now()
        });
        await this.#replyControlDurably(event.replyToken, {
          type: "text",
          text: disabled
            ? `หยุดรายงานตามเวลาของ ${client.name} แล้ว`
            : `${client.name} ยังไม่ได้เปิดรายงานตามเวลา`
        });
        return true;
      }
      if (command.kind === "shortcut_list") {
        await this.#replyControlDurably(event.replyToken, buildShortcutListMessage({
          client,
          shortcuts: this.store.listCampaignShortcuts({ clientId: client.id })
        }));
        return true;
      }
      if (command.kind === "shortcut_upsert") {
        const saved = this.store.saveCampaignShortcut({
          clientId: client.id,
          shortcutName: command.shortcutName,
          campaignNameTemplate: this.#validateCampaignNameTemplate(
            client,
            command.campaignNameTemplate
          ),
          dailyBudgetMinor: this.#validateControlBudget(client, command.dailyBudget),
          targetRoiMilli: this.#validateControlRoi(client, command.targetRoi),
          topUpThresholdBps: this.#validateTopUpThreshold(client, command.topUpThresholdPercent),
          lineUserId: userId,
          createdAt: this.now()
        });
        await this.#replyControlDurably(event.replyToken, [
          { type: "text", text: `✅ บันทึก Shortcut ${saved.shortcutName} revision ${saved.revision} แล้ว` },
          buildShortcutListMessage({ client, shortcuts: [saved] })
        ]);
        return true;
      }
      if (command.kind === "action") {
        const request = this.#requestForControlCommand(
          client,
          userId,
          command,
          controlRequestIdForEvent(eventId)
        );
        await this.#replyControlDurably(event.replyToken, buildControlConfirmationMessage(request));
        return true;
      }
      if (command.kind === "coupon_schedule") {
        if (
          command.leadMinutes < client.lineControl.minCouponLeadMinutes
          || command.leadMinutes > client.lineControl.maxCouponLeadMinutes
        ) {
          throw new DomainError(
            "COUPON_LEAD_OUT_OF_POLICY",
            `ตั้งเตือนล่วงหน้าได้ ${client.lineControl.minCouponLeadMinutes}–${client.lineControl.maxCouponLeadMinutes} นาที`
          );
        }
        const eventAt = localBangkokDateTime(
          command.localDate,
          command.localTime,
          client.timezone
        );
        const notifyAt = new Date(eventAt.getTime() - command.leadMinutes * 60_000);
        if (notifyAt.getTime() <= this.now().getTime()) {
          throw new DomainError("COUPON_SCHEDULE_IN_PAST", "เวลาแจ้งเตือนคูปองต้องอยู่ในอนาคต");
        }
        const { snapshot, stale } = this.#latestControlSnapshot(client);
        const request = this.#createControlRequest({
          client,
          userId,
          action: "SCHEDULE_COUPON_BOOST",
          source: "LINE_COUPON_SCHEDULE",
          before: this.#beforeFromSnapshot(snapshot, stale),
          desired: {
            eventAt: eventAt.toISOString(),
            notifyAt: notifyAt.toISOString(),
            leadMinutes: command.leadMinutes,
            dailyBudgetMinor: this.#validateControlBudget(client, command.amount)
          },
          requestId: controlRequestIdForEvent(eventId)
        });
        await this.#replyControlDurably(event.replyToken, buildControlConfirmationMessage(request));
        return true;
      }
      if (command.kind === "coupon_cancel") {
        const count = this.store.cancelPendingCouponSchedules({
          clientId: client.id,
          lineUserId: userId,
          now: this.now()
        });
        await this.#replyControlDurably(event.replyToken, {
          type: "text",
          text: count > 0
            ? `ยกเลิกการแจ้งเตือนคูปองของ ${client.name} ${count} รายการแล้ว`
            : `ไม่พบการแจ้งเตือนคูปองที่รอยกเลิกของ ${client.name}`
        });
        return true;
      }
      return false;
    } catch (error) {
      if (error?.code === "LINE_CONTROL_REPLY_FAILED") throw error;
      if (new Set([
        "CLIENT_NOT_FOUND",
        "CLIENT_ALIAS_AMBIGUOUS",
        "LINE_NOT_AUTHORIZED"
      ]).has(error?.code)) {
        await this.#replyControlDurably(
          event.replyToken,
          command.kind === "menu"
            ? this.#controlFallbackMessage(userId)
            : this.#lineControlSelectionRequiredMessage()
        );
        return true;
      }
      const safe = safeError(error);
      const reconnectRequired = new Set([
        "TIKTOK_CREDENTIAL_EXPIRED",
        "TIKTOK_CREDENTIAL_NOT_FOUND"
      ]).has(safe.code);
      await this.#replyControlDurably(event.replyToken, {
        type: "text",
        text: reconnectRequired
          ? `สิทธิ์ TikTok API ไม่มีหรือหมดอายุ กรุณาส่ง “เชื่อม TikTok API ${command.clientAlias}” ใหม่`
          : `${command.kind.startsWith("auto_boost_") ? "🧪 DRY-RUN — " : ""}คำสั่งยังทำไม่ได้: ${safe.message}`
      });
      return true;
    }
  }

  async #handleControlPostback(event, userId) {
    const parsed = parseControlPostbackData(event.postback?.data);
    if (!parsed) return false;
    if (event.source?.type && event.source.type !== "user") {
      await this.#replyControlDurably(event.replyToken, {
        type: "text",
        text: "กรุณายืนยันคำสั่งในแชตส่วนตัวกับ LINE OA เท่านั้น"
      });
      return true;
    }
    const request = this.store.getCampaignControlRequest(parsed.requestId);
    if (!request) {
      await this.#replyControlDurably(event.replyToken, { type: "text", text: "ไม่พบคำสั่งนี้ หรือคำสั่งถูกลบไปแล้ว" });
      return true;
    }
    const client = this.#clientById(request.clientId);
    if (!client || !this.#isCurrentApprover(client, userId)) {
      await this.#replyControlDurably(event.replyToken, { type: "text", text: "คุณไม่มีสิทธิ์ยืนยันคำสั่งของบัญชีนี้" });
      return true;
    }
    try {
      const outcome = parsed.action === "confirm" ? "confirm" : "reject";
      const couponResolution = request.action === "SCHEDULE_COUPON_BOOST"
        ? this.store.transitionCouponBoostControlRequest({
            id: request.id,
            version: parsed.version,
            lineUserId: userId,
            outcome,
            now: this.now()
          })
        : null;
      const updated = couponResolution?.request ?? this.store.transitionCampaignControlRequest({
        id: request.id,
        version: parsed.version,
        lineUserId: userId,
        outcome,
        now: this.now()
      });
      if (updated.state === "EXPIRED") {
        await this.#replyControlDurably(event.replyToken, { type: "text", text: "คำสั่งนี้หมดอายุแล้ว ไม่มีการเปลี่ยนแปลง TikTok" });
        return true;
      }
      if (updated.state === "CANCELLED") {
        await this.#replyControlDurably(event.replyToken, { type: "text", text: "ยกเลิกคำสั่งแล้ว" });
        return true;
      }
      if (updated.action === "SCHEDULE_COUPON_BOOST") {
        const schedule = couponResolution?.schedule;
        if (!schedule) {
          throw new DomainError(
            "COUPON_SCHEDULE_MISSING",
            "Coupon confirmation did not create a durable schedule"
          );
        }
        await this.#replyControlDurably(event.replyToken, {
          type: "text",
          text: [
            "✅ บันทึก Coupon Boost แล้ว",
            `ระบบจะเตือนเวลา ${new Date(schedule.notifyAt).toLocaleString("th-TH", { timeZone: client.timezone, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}`,
            "ระหว่างรอ API ระบบจะส่งคำขอทดสอบและไม่เปลี่ยนงบ TikTok จริง"
          ].join("\n")
        });
        return true;
      }
      await this.#replyControlDurably(event.replyToken, {
        type: "text",
        text: "🧪 ยืนยันการทดสอบแล้ว — ระบบบันทึก Audit แต่ยังไม่มีการเปลี่ยนแปลงบน TikTok"
      });
      return true;
    } catch (error) {
      if (error?.code === "LINE_CONTROL_REPLY_FAILED") throw error;
      const safe = safeError(error);
      await this.#replyControlDurably(event.replyToken, {
        type: "text",
        text: `คำสั่งนี้ใช้ไม่ได้แล้ว: ${safe.message}`
      });
      return true;
    }
  }

  async #handlePostback(event, userId) {
    const parsed = parsePostbackData(event.postback?.data);
    if (!parsed) return this.#replySafely(event.replyToken, { type: "text", text: "คำสั่งไม่ถูกต้อง กรุณาใช้ปุ่มจากข้อความล่าสุด" });
    const request = this.store.getBudgetRequest(parsed.requestId);
    if (!request || !request.authorizedLineUserIds.includes(userId)) {
      return this.#replySafely(event.replyToken, { type: "text", text: "ไม่พบคำขอ หรือคุณไม่มีสิทธิ์อนุมัติบัญชีนี้" });
    }

    if (parsed.action === "custom") {
      if (!allowsManualTarget(request)) {
        return this.#replySafely(event.replyToken, {
          type: "text",
          text: "คำขอนี้อนุญาตเฉพาะงบที่ระบบแนะนำ กรุณาใช้ปุ่มเพิ่มงบจากข้อความล่าสุด"
        }, request.id);
      }
      if (request.state !== RequestState.PENDING_INPUT) {
        return this.#replySafely(event.replyToken, { type: "text", text: "คำขอนี้กรอกงบแล้วหรือถูกปิดไปแล้ว" }, request.id);
      }
      const code = requestCodeFor(request.id);
      const maxBudget = fromMinor(request.guardrails.maxBudgetMinor, request.currency);
      return this.#replySafely(event.replyToken, {
        type: "text",
        text: `พิมพ์งบใหม่ทั้งก้อนในรูปแบบนี้:\nงบ ${code} ${maxBudget}\n\nงบต้องมากกว่างบปัจจุบันและไม่เกิน ${maxBudget} ${request.currency}\nคำขอจะหมดอายุ ${new Date(request.expiresAt).toLocaleTimeString("th-TH", { timeZone: request.metadata.timezone, hour: "2-digit", minute: "2-digit" })}`
      }, request.id);
    }

    if (parsed.action === "reject") {
      try {
        this.store.cancelBudgetRequest(request.id, { actorLineUserId: userId, reason: "Rejected in LINE", now: this.now() });
        return this.#replySafely(event.replyToken, { type: "text", text: "ยกเลิกคำขอเพิ่มงบแล้ว" }, request.id);
      } catch (error) {
        return this.#replySafely(event.replyToken, { type: "text", text: `คำขอนี้ดำเนินการไปแล้ว (${request.state})` }, request.id);
      }
    }

    if (parsed.action === "suggest") {
      if (request.state !== RequestState.PENDING_INPUT) {
        return this.#replySafely(event.replyToken, { type: "text", text: "คำขอนี้มีการระบุงบแล้ว กรุณายืนยันจากข้อความสรุปล่าสุดเท่านั้น" }, request.id);
      }
      try {
        const updated = this.store.submitBudgetAmount(request.id, {
          actorLineUserId: userId,
          increaseMinor: request.metadata.suggestedTargetMinor - request.currentBudgetMinor,
          now: this.now()
        });
        return this.#replySafely(event.replyToken, buildBudgetConfirmationMessage(this.#view(updated)), request.id);
      } catch (error) {
        const safe = safeError(error);
        return this.#replySafely(event.replyToken, { type: "text", text: `ไม่สามารถตั้งงบแนะนำได้: ${safe.message}` }, request.id);
      }
    }

    if (parsed.action === "confirm" && request.state === RequestState.PENDING_APPROVAL) {
      const now = this.now();
      if (now.getTime() >= Date.parse(request.expiresAt)) {
        try {
          this.store.expireBudgetRequest(request.id, { now });
        } catch (error) {
          if (!new Set(["CONCURRENT_MODIFICATION", "INVALID_STATE"]).has(error?.code)) throw error;
        }
        return this.#replySafely(event.replyToken, {
          type: "text",
          text: "คำขอนี้หมดอายุแล้ว ไม่มีการเปลี่ยนงบจริง"
        }, request.id);
      }
      if (parsed.version !== request.version) {
        return this.#replySafely(event.replyToken, { type: "text", text: "ข้อความยืนยันนี้เป็นเวอร์ชันเก่า กรุณาใช้ข้อความสรุปล่าสุด" }, request.id);
      }
      if (telemetryOnlyRequest(request)) {
        const completed = this.store.cancelBudgetRequest(request.id, {
          actorLineUserId: userId,
          reason: "Dry run: telemetry-only LINE confirmation",
          now
        });
        await this.#pushResult(userId, completed, {
          ok: true,
          dryRun: true,
          detail: "ยืนยันการทดสอบแล้ว—ไม่มีการเปลี่ยนงบจริงบน TikTok"
        });
        return this.#replySafely(event.replyToken, {
          type: "text",
          text: "จบการทดสอบแล้ว ✅ ไม่มีการเปลี่ยนงบจริงบน TikTok"
        }, request.id);
      }
      const queued = this.store.enqueueExecutionJob({
        requestId: request.id,
        actorLineUserId: userId,
        createdAt: now
      });
      return this.#replySafely(event.replyToken, {
        type: "text",
        text: queued.enqueued
          ? "รับคำยืนยันและบันทึกคิวถาวรแล้ว ระบบกำลังตรวจสอบบัญชีและงบล่าสุด…"
          : "คำขอนี้อยู่ในคิวแล้ว ระบบจะส่งผลกลับให้ทาง LINE"
      }, request.id);
    }

    return this.#replySafely(event.replyToken, { type: "text", text: `คำสั่งนี้ใช้ไม่ได้ในสถานะปัจจุบัน (${request.state})` }, request.id);
  }

  async #handleText(event, userId, eventId = null) {
    const pairing = parsePairingText(event.message?.text);
    if (pairing) {
      return this.#handlePairingCommand({
        clientId: pairing.clientId,
        codeHash: pairingCodeHash(pairing.clientId, pairing.code),
        userId,
        sourceType: event.source?.type ?? null,
        replyToken: event.replyToken
      });
    }
    const parsed = parseBudgetText(event.message?.text);
    if (!parsed) return this.#handleControlCommand(event, userId, null, eventId);
    const candidates = this.store.listBudgetRequests({ state: RequestState.PENDING_INPUT, limit: 1000 });
    const matches = candidates.filter((item) => {
      try {
        return requestCodeFor(item.id) === parsed.requestCode && item.authorizedLineUserIds.includes(userId);
      } catch {
        return false;
      }
    });
    if (matches.length !== 1) {
      return this.#replySafely(event.replyToken, { type: "text", text: "ไม่พบคำของบที่ยังเปิดอยู่ กรุณาใช้รหัสจากข้อความล่าสุด" });
    }
    const [request] = matches;
    if (!allowsManualTarget(request)) {
      return this.#replySafely(event.replyToken, {
        type: "text",
        text: "คำขอนี้ไม่อนุญาตให้กรอกงบเอง กรุณาใช้ปุ่มเพิ่มงบจากข้อความล่าสุด"
      }, request.id);
    }
    try {
      const targetMinor = toMinor(parsed.amount, request.currency);
      const updated = this.store.submitBudgetAmount(request.id, {
        actorLineUserId: userId,
        increaseMinor: targetMinor - request.currentBudgetMinor,
        now: this.now()
      });
      return this.#replySafely(event.replyToken, buildBudgetConfirmationMessage(this.#view(updated)), request.id);
    } catch (error) {
      const safe = safeError(error);
      return this.#replySafely(event.replyToken, { type: "text", text: `งบนี้ใช้ไม่ได้: ${safe.message}` }, request.id);
    }
  }

  async handleLineEvents(events) {
    const results = [];
    for (const event of events ?? []) {
      const eventId = webhookEventId(event);
      this.store.recordWebhookEvent({
        provider: "LINE",
        eventId,
        payload: {
          type: event.type,
          timestamp: event.timestamp ?? null,
          sourceType: event.source?.type ?? null,
          messageType: event.message?.type ?? null,
          isRedelivery: Boolean(event.deliveryContext?.isRedelivery),
          command: normalizedLineCommand(event)
        },
        receivedAt: this.now()
      });
      const claim = this.store.claimWebhookEvent({
        provider: "LINE",
        eventId,
        claimedAt: this.now(),
        leaseDurationMs: 10_000
      });
      if (!claim.claimed) {
        results.push({ eventId, status: claim.reason === "PROCESSED" ? "DUPLICATE" : "IN_PROGRESS" });
        continue;
      }
      const leaseToken = claim.event.leaseToken;
      const userId = event.source?.userId;
      try {
        if (!userId) {
          this.store.markWebhookEvent({ provider: "LINE", eventId, leaseToken, status: "PROCESSED", processedAt: this.now() });
          results.push({ eventId, status: "IGNORED_NO_USER" });
          continue;
        }
        if (event.type === "postback") {
          const handledControl = await this.#handleControlPostback(event, userId);
          if (!handledControl) await this.#handlePostback(event, userId);
        }
        if (event.type === "message" && event.message?.type === "text") await this.#handleText(event, userId, eventId);
        this.store.markWebhookEvent({ provider: "LINE", eventId, leaseToken, status: "PROCESSED", processedAt: this.now() });
        results.push({ eventId, status: "PROCESSED" });
      } catch (error) {
        const safe = safeError(error);
        this.store.markWebhookEvent({
          provider: "LINE",
          eventId,
          leaseToken,
          status: "FAILED",
          errorCode: safe.code,
          processedAt: this.now()
        });
        results.push({ eventId, status: "FAILED", error: safe });
      }
    }
    return results;
  }

  #controlCommandAlreadyApplied(command, eventId) {
    const control = command.command;
    if (new Set([
      "agency_menu",
      "agency_report",
      "agency_section",
      "invalid_template",
      "my_line_id"
    ]).has(control.kind)) {
      return true;
    }
    let client;
    try {
      client = this.#lineControlClient(control.clientAlias, command.userId);
    } catch (error) {
      if (new Set([
        "CLIENT_NOT_FOUND",
        "CLIENT_ALIAS_AMBIGUOUS",
        "LINE_NOT_AUTHORIZED"
      ]).has(error?.code)) return true;
      throw error;
    }
    if (new Set([
      "menu",
      "help",
      "status",
      "shortcut_list",
      "auto_boost_status",
      "campaign_create_template",
      "campaign_close_menu",
      "campaign_adjust_menu",
      "auto_boost_setup"
    ]).has(control.kind)) {
      return true;
    }
    if (new Set(["action", "coupon_schedule"]).has(control.kind)) {
      return Boolean(this.store.getCampaignControlRequest(controlRequestIdForEvent(eventId)));
    }
    if (control.kind === "report_subscribe") {
      const subscription = this.store.getReportSubscription({
        clientId: client.id,
        lineUserId: command.userId
      });
      return subscription?.enabled === true
        && subscription.intervalMinutes === control.intervalHours * 60;
    }
    if (control.kind === "report_unsubscribe") {
      const subscription = this.store.getReportSubscription({
        clientId: client.id,
        lineUserId: command.userId
      });
      return !subscription?.enabled;
    }
    if (control.kind === "shortcut_upsert") {
      const shortcut = this.store.getCampaignShortcut({
        clientId: client.id,
        shortcutName: control.shortcutName
      });
      if (!shortcut) return false;
      return shortcut.campaignNameTemplate === this.#validateCampaignNameTemplate(
        client,
        control.campaignNameTemplate
      )
        && shortcut.dailyBudgetMinor === this.#validateControlBudget(client, control.dailyBudget)
        && shortcut.targetRoiMilli === this.#validateControlRoi(client, control.targetRoi)
        && shortcut.topUpThresholdBps === this.#validateTopUpThreshold(
          client,
          control.topUpThresholdPercent
        );
    }
    if (control.kind === "auto_boost_upsert") {
      const profile = this.store.getAutoBoostProfile({ clientId: client.id });
      return profile?.sourceEventId === String(eventId);
    }
    if (control.kind === "auto_boost_toggle") {
      const profile = this.store.getAutoBoostProfile({ clientId: client.id });
      return profile?.lastToggleSourceEventId === String(eventId)
        && profile.enabled === control.enabled;
    }
    // Cancelling pending coupon schedules is itself idempotent.
    if (control.kind === "coupon_cancel") return false;
    return true;
  }

  async #sendRecoveredLineResponse(command, eventId) {
    let message = null;
    let requestId = null;
    let controlRequestId = null;
    if (command.kind === "control_postback") {
      if (command.sourceType && command.sourceType !== "user") return null;
      const parsed = parseControlPostbackData(command.data);
      controlRequestId = parsed?.requestId ?? null;
      const request = controlRequestId
        ? this.store.getCampaignControlRequest(controlRequestId)
        : null;
      if (request) {
        const client = this.#clientById(request.clientId);
        if (!client || !this.#isCurrentApprover(client, command.userId)) return null;
        const couponSchedule = request.action === "SCHEDULE_COUPON_BOOST"
          ? this.store.getCouponScheduleByControlRequestId(request.id)
          : null;
        message = {
          type: "text",
          text: couponSchedule && request.state === "CONFIRMED_DRY_RUN"
            ? "✅ ระบบกู้คำยืนยันแล้ว: บันทึก Coupon Boost แบบทดสอบเรียบร้อย"
            : request.state === "CONFIRMED_DRY_RUN"
              ? "🧪 ระบบกู้คำยืนยันแล้ว — ไม่มีการเปลี่ยนแปลง TikTok ในโหมดทดสอบ"
            : request.state === "CANCELLED"
              ? "ระบบกู้คำสั่งแล้ว: ยกเลิกคำสั่งเรียบร้อย"
              : `ระบบกู้คำสั่งแล้ว แต่คำสั่งอยู่ในสถานะ ${request.state}`
        };
      } else {
        message = { type: "text", text: "ไม่พบคำสั่งที่ต้องกู้คืน กรุณาส่งคำสั่งใหม่อีกครั้ง" };
      }
    } else if (command.kind === "control_fallback") {
      if (command.sourceType && command.sourceType !== "user") return null;
      message = this.#controlFallbackMessage(command.userId);
    } else if (command.kind === "control_command") {
      if (command.sourceType && command.sourceType !== "user") return null;
      const control = command.command;
      const agencyMessage = this.#agencyCommandMessage(control, command.userId);
      if (agencyMessage) {
        message = agencyMessage;
      } else {
        let client;
        try {
          client = this.#lineControlClient(control.clientAlias, command.userId);
        } catch (error) {
          if (new Set([
            "CLIENT_NOT_FOUND",
            "CLIENT_ALIAS_AMBIGUOUS",
            "LINE_NOT_AUTHORIZED"
          ]).has(error?.code)) {
            message = control.kind === "menu"
              ? this.#controlFallbackMessage(command.userId)
              : this.#lineControlSelectionRequiredMessage();
            client = null;
          } else {
            throw error;
          }
        }
        const selectedPageMessage = client
          ? this.#selectedControlPageMessage(control, client)
          : null;
        if (selectedPageMessage) {
          message = selectedPageMessage;
        } else if (message) {
          // Authorization and unknown-alias recovery responses are intentionally
          // generic and must never include a configured client name.
        } else if (control.kind === "menu") {
          message = buildControlMenuMessage(client);
        } else if (control.kind === "help") {
          message = { type: "text", text: controlHelpText(client) };
        } else if (control.kind === "status") {
          const { snapshot, stale } = this.#latestControlSnapshot(client);
          message = buildPerformanceReportMessage({ client, snapshot, stale, now: this.now() });
        } else if (control.kind === "tiktok_oauth_start") {
          message = {
            type: "text",
            text: [
              "ลิงก์เชื่อม TikTok เดิมส่งไม่สำเร็จและไม่สามารถนำกลับมาใช้ซ้ำได้",
              `กรุณาส่ง “เชื่อม TikTok API ${client.lineControl.aliases[0]}” อีกครั้งเพื่อรับลิงก์ใหม่`
            ].join("\n")
          };
        } else if (control.kind === "tiktok_api_preflight") {
          if (!this.tiktokApiControl) {
            message = {
              type: "text",
              text: "ระบบ TikTok API ยังไม่ได้เปิดบนเซิร์ฟเวอร์"
            };
          } else {
            const result = await this.tiktokApiControl.preflightClient(client);
            message = buildTikTokPreflightMessage({ client, result });
          }
        } else if (new Set([
          "auto_boost_status",
          "auto_boost_upsert",
          "auto_boost_toggle"
        ]).has(control.kind)) {
          const profile = this.store.getAutoBoostProfile({ clientId: client.id });
          message = profile
            ? this.#autoBoostStatusMessage(client, profile)
            : {
                type: "text",
                text: `ไม่พบตาราง Auto Boost ของ ${client.name} กรุณาส่งคำสั่งตั้งตารางใหม่`
              };
        } else if (new Set(["shortcut_list", "shortcut_upsert"]).has(control.kind)) {
          message = buildShortcutListMessage({
            client,
            shortcuts: this.store.listCampaignShortcuts({ clientId: client.id })
          });
        } else if (control.kind === "report_subscribe") {
          const subscription = this.store.getReportSubscription({
            clientId: client.id,
            lineUserId: command.userId
          });
          message = {
            type: "text",
            text: subscription?.enabled
              ? `✅ กู้คำสั่งแล้ว: รายงาน ${client.name} ทุก ${subscription.intervalMinutes / 60} ชั่วโมงเปิดอยู่`
              : `ตั้งรายงาน ${client.name} ไม่สำเร็จ กรุณาส่งคำสั่งใหม่`
          };
        } else if (control.kind === "report_unsubscribe") {
          const subscription = this.store.getReportSubscription({
            clientId: client.id,
            lineUserId: command.userId
          });
          message = {
            type: "text",
            text: !subscription?.enabled
              ? `กู้คำสั่งแล้ว: รายงานตามเวลาของ ${client.name} ถูกหยุดแล้ว`
              : `หยุดรายงาน ${client.name} ไม่สำเร็จ กรุณาส่งคำสั่งใหม่`
          };
        } else if (new Set(["action", "coupon_schedule"]).has(control.kind)) {
          controlRequestId = controlRequestIdForEvent(eventId);
          const request = this.store.getCampaignControlRequest(controlRequestId);
          message = request
            ? buildControlConfirmationMessage(request)
            : { type: "text", text: `คำสั่ง ${client.name} ไม่ได้ถูกบันทึก กรุณาส่งคำสั่งใหม่` };
        } else {
          message = { type: "text", text: `ระบบกู้คำสั่ง ${client.name} แล้ว กรุณาตรวจสถานะจากเมนู` };
        }
      }
    } else if (command.kind === "postback") {
      const parsed = parsePostbackData(command.data);
      requestId = parsed?.requestId ?? null;
      const request = requestId ? this.store.getBudgetRequest(requestId) : null;
      if (!request || !request.authorizedLineUserIds.includes(command.userId)) return null;
      if (parsed?.action === "suggest" && request?.state === RequestState.PENDING_APPROVAL) {
        message = buildBudgetConfirmationMessage(this.#view(request));
      } else if (parsed?.action === "custom") {
        message = allowsManualTarget(request)
          ? { type: "text", text: "ระบบกู้คำสั่ง “กรอกงบเอง” แล้ว กรุณากดปุ่มจากข้อความล่าสุดอีกครั้งเพื่อรับรูปแบบและรหัสคำขอ" }
          : { type: "text", text: "คำขอนี้อนุญาตเฉพาะงบที่ระบบแนะนำ กรุณาใช้ปุ่มเพิ่มงบจากข้อความล่าสุด" };
      } else if (parsed?.action === "reject") {
        const rejected = request.state === RequestState.CANCELLED && request.cancellation?.reason === "Rejected in LINE";
        message = {
          type: "text",
          text: rejected
            ? "ระบบกู้คำสั่งแล้ว: คำขอเพิ่มงบถูกยกเลิก"
            : `ระบบกู้คำสั่งแล้ว แต่ไม่ได้ยกเลิกคำขอ เนื่องจากคำขออยู่ในสถานะ ${request.state}`
        };
      }
    } else if (command.kind === "budget_text") {
      const parsed = parseBudgetText(command.text);
      const matches = this.store.listBudgetRequests({ limit: 1000 })
        .filter((request) =>
          [RequestState.PENDING_INPUT, RequestState.PENDING_APPROVAL].includes(request.state) &&
          request.authorizedLineUserIds.includes(command.userId) &&
          requestCodeFor(request.id) === parsed?.requestCode
        );
      if (matches.length === 1) {
        requestId = matches[0].id;
        if (!allowsManualTarget(matches[0])) {
          message = { type: "text", text: "คำขอนี้ไม่อนุญาตให้กรอกงบเอง กรุณาใช้ปุ่มเพิ่มงบจากข้อความล่าสุด" };
        } else if (matches[0].state === RequestState.PENDING_APPROVAL) {
          message = buildBudgetConfirmationMessage(this.#view(matches[0]));
        }
      }
    } else if (command.kind === "pairing") {
      const client = this.#clientById(command.clientId);
      if (client && this.store.isLineApprover({ clientId: client.id, lineUserId: command.userId })) {
        message = { type: "text", text: `✅ ระบบกู้คำสั่งและยืนยันการจับคู่ผู้อนุมัติของ ${client.name} แล้ว` };
      }
    }
    if (!message) return requestId;
    const retryKey = stableRetryKey("webhook-recovery", eventId, command.userId);
    await this.line.push(command.userId, message, retryKey);
    this.store.appendAuditEvent({
      requestId,
      eventType: "LINE_WEBHOOK_RECOVERY_RESPONSE_SENT",
      actorType: "SYSTEM",
      occurredAt: this.now(),
      details: { eventId, retryKey, controlRequestId }
    });
    return requestId;
  }

  async recoverLineWebhookEvents({ maxEvents = 20 } = {}) {
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 1000) {
      throw new Error("maxEvents must be an integer between 1 and 1000");
    }
    const outcomes = [];
    const attemptedEventIds = [];
    for (let index = 0; index < maxEvents; index += 1) {
      const claim = this.store.claimNextWebhookEvent({
        provider: "LINE",
        claimedAt: this.now(),
        leaseDurationMs: 120_000,
        excludeEventIds: attemptedEventIds
      });
      if (!claim) break;
      const { event } = claim;
      attemptedEventIds.push(event.eventId);
      const command = event.payload.command;
      let requestId = null;
      try {
        const replyOnlyRecovery = claim.priorStatus === "FAILED"
          && claim.priorErrorCode === "LINE_CONTROL_REPLY_FAILED";
        if (command?.kind === "control_postback") {
          const parsed = parseControlPostbackData(command.data);
          const controlRequest = parsed?.requestId
            ? this.store.getCampaignControlRequest(parsed.requestId)
            : null;
          if (!replyOnlyRecovery && controlRequest?.state === "PENDING_CONFIRMATION") {
            await this.#handleControlPostback(
              {
                type: "postback",
                source: { userId: command.userId, type: command.sourceType },
                postback: { data: command.data }
              },
              command.userId
            );
          }
        } else if (command?.kind === "control_command") {
          if (
            !replyOnlyRecovery
            && !this.#controlCommandAlreadyApplied(command, event.eventId)
          ) {
            await this.#handleControlCommand(
              {
                type: "message",
                source: { userId: command.userId, type: command.sourceType },
                message: { type: "text", text: "" }
              },
              command.userId,
              command.command,
              event.eventId
            );
          }
        } else if (command?.kind === "postback") {
          const parsed = parsePostbackData(command.data);
          requestId = parsed?.requestId ?? null;
          await this.#handlePostback({ type: "postback", source: { userId: command.userId }, postback: { data: command.data } }, command.userId);
        } else if (command?.kind === "budget_text") {
          await this.#handleText(
            { type: "message", source: { userId: command.userId }, message: { type: "text", text: command.text } },
            command.userId,
            event.eventId
          );
        } else if (command?.kind === "pairing") {
          await this.#handlePairingCommand({
            clientId: command.clientId,
            codeHash: command.codeHash,
            userId: command.userId,
            sourceType: command.sourceType,
            replyToken: null
          });
        }
        requestId = (await this.#sendRecoveredLineResponse(command ?? {}, event.eventId)) ?? requestId;
        this.store.markWebhookEvent({
          provider: "LINE",
          eventId: event.eventId,
          leaseToken: event.leaseToken,
          status: "PROCESSED",
          requestId,
          processedAt: this.now()
        });
        outcomes.push({ eventId: event.eventId, status: "RECOVERED" });
      } catch (error) {
        const safe = safeError(error);
        this.store.markWebhookEvent({
          provider: "LINE",
          eventId: event.eventId,
          leaseToken: event.leaseToken,
          status: "FAILED",
          requestId,
          errorCode: safe.code,
          processedAt: this.now()
        });
        outcomes.push({ eventId: event.eventId, status: "FAILED", error: safe });
      }
    }
    return outcomes;
  }

  async processScheduledLineControls({
    reportLimit = 100,
    couponLimit = 20,
    autoBoostLimit = 40
  } = {}) {
    const outcomes = [];
    // Auto Boost is materialized deterministically for the current Bangkok
    // date. Re-running this on every worker cycle is safe across restarts.
    for (const client of this.config.clients) {
      const profile = client.lineControl?.enabled === true
        && client.lineControl?.autoBoost?.enabled === true
        ? this.store.getAutoBoostProfile({ clientId: client.id })
        : null;
      if (!profile?.enabled) continue;
      try {
        this.#materializeAutoBoostToday(client, profile, this.now());
      } catch (error) {
        outcomes.push({
          type: "AUTO_BOOST",
          clientId: client.id,
          status: "MATERIALIZE_SKIPPED",
          error: safeError(error)
        });
      }
    }

    // Coupon reminders get the first LINE delivery slot so a degraded LINE API
    // cannot let a batch of Auto Boost retries hold them past their event.
    for (const schedule of this.store.claimDueCouponSchedules({
      now: this.now(),
      limit: couponLimit
    })) {
      const client = this.#clientById(schedule.clientId);
      try {
        const itemNow = this.now();
        if (!client || !this.#isCurrentApprover(client, schedule.lineUserId)) {
          throw new DomainError("LINE_NOT_AUTHORIZED", "Coupon schedule approver is no longer authorized");
        }
        if (itemNow.getTime() > Date.parse(schedule.eventAt) + 15 * 60_000) {
          throw new DomainError("COUPON_SCHEDULE_EXPIRED", "Coupon reminder is more than 15 minutes late");
        }
        this.#validateControlBudget(client, schedule.budgetMinor / 100);
        const { snapshot, stale } = this.#latestControlSnapshot(client);
        const requestId = controlRequestIdForEvent(`coupon:${schedule.id}`);
        const request = this.#createControlRequest({
          client,
          userId: schedule.lineUserId,
          action: "UPDATE_BUDGET",
          source: "COUPON_REMINDER",
          requestId,
          before: this.#beforeFromSnapshot(snapshot, stale),
          desired: {
            dailyBudgetMinor: schedule.budgetMinor,
            couponScheduleId: schedule.id,
            eventAt: schedule.eventAt
          }
        });
        const retryKey = stableRetryKey("coupon-reminder", schedule.id, schedule.lineUserId);
        await this.line.push(
          schedule.lineUserId,
          buildCouponReminderMessage({
            clientName: client.name,
            eventAt: schedule.eventAt,
            budgetMinor: schedule.budgetMinor,
            request
          }),
          retryKey
        );
        this.store.finishCouponSchedule({ id: schedule.id, ok: true, now: this.now() });
        outcomes.push({ type: "COUPON", clientId: client.id, status: "SENT", requestId });
      } catch (error) {
        this.store.finishCouponSchedule({
          id: schedule.id,
          ok: false,
          now: this.now(),
          error: error?.message ?? error
        });
        outcomes.push({
          type: "COUPON",
          clientId: schedule.clientId,
          status: "FAILED",
          error: safeError(error)
        });
      }
    }

    // The pilot deliberately sends only LINE DRY-RUN messages and never calls
    // TikTok. Auto Boost still runs before lower-priority periodic reports.
    for (const occurrence of this.store.claimDueAutoBoostOccurrences({
      now: this.now(),
      limit: autoBoostLimit
    })) {
      const client = this.#clientById(occurrence.clientId);
      const profile = this.store.getAutoBoostProfile({ clientId: occurrence.clientId });
      let deliveryAttempted = false;
      try {
        if (!profile) {
          throw new DomainError("AUTO_BOOST_PROFILE_MISSING", "Auto Boost profile is no longer available");
        }
        if (occurrence.phase === "BOOST") {
          const blockingRestore = this.store.getBlockingAutoBoostRestore({
            clientId: occurrence.clientId,
            beforeAt: occurrence.dueAt
          });
          if (blockingRestore) {
            this.store.releaseAutoBoostOccurrence({
              id: occurrence.id,
              leaseToken: occurrence.leaseToken,
              now: this.now(),
              error: `Waiting for required RESTORE (${blockingRestore.id})`
            });
            outcomes.push({
              type: "AUTO_BOOST",
              clientId: occurrence.clientId,
              phase: occurrence.phase,
              status: "DEFERRED_WAITING_FOR_RESTORE"
            });
            continue;
          }
          const markOutcomeUnknown = (reason) => {
            this.store.finishAutoBoostOccurrence({
              id: occurrence.id,
              leaseToken: occurrence.leaseToken,
              status: "OUTCOME_UNKNOWN",
              now: this.now(),
              error: reason
            });
            outcomes.push({
              type: "AUTO_BOOST",
              clientId: occurrence.clientId,
              phase: occurrence.phase,
              status: "OUTCOME_UNKNOWN"
            });
          };
          if (!profile.enabled) {
            if (occurrence.attemptCount > 1) {
              markOutcomeUnknown("BOOST was already attempted before Auto Boost was disabled");
              continue;
            }
            throw new DomainError("AUTO_BOOST_PROFILE_DISABLED", "Auto Boost is no longer enabled");
          }
          if (!client) {
            if (occurrence.attemptCount > 1) {
              markOutcomeUnknown("BOOST was already attempted before its client configuration disappeared");
              continue;
            }
            throw new DomainError("CLIENT_NOT_FOUND", "Auto Boost client is no longer configured");
          }
          try {
            this.#assertAutoBoostProfileCurrent(client, profile);
          } catch (error) {
            if (occurrence.attemptCount > 1) {
              markOutcomeUnknown(
                `BOOST was already attempted before its policy changed: ${error?.message ?? error}`
              );
              continue;
            }
            throw error;
          }
        } else {
          if (profile.executionMode !== "DRY_RUN") {
            throw new DomainError(
              "AUTO_BOOST_EXECUTION_MODE_UNSAFE",
              "Auto Boost restore drain must remain DRY-RUN"
            );
          }
        }
        if (
          occurrence.revision !== profile.revision
          || occurrence.activationGeneration !== profile.activationGeneration
        ) {
          throw new DomainError(
            "AUTO_BOOST_OCCURRENCE_STALE",
            "Auto Boost occurrence belongs to an older profile activation"
          );
        }
        if (occurrence.phase === "RESTORE") {
          const matchingBoost = this.store.listAutoBoostOccurrences({
            clientId: occurrence.clientId,
            revision: occurrence.revision,
            activationGeneration: occurrence.activationGeneration,
            localDate: occurrence.localDate,
            phase: "BOOST",
            limit: 1_000
          }).find((candidate) => candidate.blockIndex === occurrence.blockIndex);
          if (new Set(["PENDING", "PROCESSING"]).has(matchingBoost?.status)) {
            this.store.releaseAutoBoostOccurrence({
              id: occurrence.id,
              leaseToken: occurrence.leaseToken,
              now: this.now(),
              error: `Waiting for matching BOOST (${matchingBoost.status})`
            });
            outcomes.push({
              type: "AUTO_BOOST",
              clientId: occurrence.clientId,
              phase: occurrence.phase,
              status: "DEFERRED_WAITING_FOR_BOOST"
            });
            continue;
          }
          if (!new Set(["DRY_RUN_COMPLETED", "OUTCOME_UNKNOWN"]).has(matchingBoost?.status)) {
            throw new DomainError(
              "AUTO_BOOST_RESTORE_WITHOUT_BOOST",
              "ข้ามการจำลองคืนงบ เพราะรอบเพิ่มงบที่ตรงกันไม่เคยสำเร็จ"
            );
          }
        }
        const currentApprovers = client ? this.#approversForClient(client) : [];
        const notificationLineUserIds = client
          ? [...new Set([
              ...(currentApprovers.includes(profile.ownerLineUserId)
                ? [profile.ownerLineUserId]
                : []),
              ...currentApprovers
            ])]
          : [];
        if (notificationLineUserIds.length === 0) {
          this.store.finishAutoBoostOccurrence({
            id: occurrence.id,
            leaseToken: occurrence.leaseToken,
            status: "DRY_RUN_COMPLETED",
            now: this.now(),
            error: "Safety RESTORE simulated without LINE notification: no current approver"
          });
          outcomes.push({
            type: "AUTO_BOOST",
            clientId: occurrence.clientId,
            phase: occurrence.phase,
            status: "DRY_RUN_COMPLETED_NO_RECIPIENT"
          });
          continue;
        }
        const message = buildAutoBoostDryRunOccurrenceMessage({ client, plan: profile, occurrence });
        const permanentErrors = [];
        let delivered = false;
        for (const notificationLineUserId of notificationLineUserIds) {
          const retryKey = stableRetryKey(
            "auto-boost-dry-run",
            occurrence.id,
            notificationLineUserId
          );
          deliveryAttempted = true;
          try {
            await this.line.push(notificationLineUserId, message, retryKey);
            delivered = true;
            break;
          } catch (error) {
            const permanentlyRejected = error?.recipientPermanent === true;
            if (!permanentlyRejected) throw error;
            permanentErrors.push(`${notificationLineUserId}: ${error?.message ?? error}`);
          }
        }
        if (!delivered) {
          const error = `LINE permanently rejected every current approver: ${permanentErrors.join(" | ")}`;
          const terminalStatus = occurrence.phase === "RESTORE" ? "DRY_RUN_COMPLETED" : "FAILED";
          this.store.finishAutoBoostOccurrence({
            id: occurrence.id,
            leaseToken: occurrence.leaseToken,
            status: terminalStatus,
            now: this.now(),
            error
          });
          outcomes.push({
            type: "AUTO_BOOST",
            clientId: occurrence.clientId,
            phase: occurrence.phase,
            status: occurrence.phase === "RESTORE"
              ? "DRY_RUN_COMPLETED_NO_RECIPIENT"
              : "LINE_REJECTED"
          });
          continue;
        }
        this.store.finishAutoBoostOccurrence({
          id: occurrence.id,
          leaseToken: occurrence.leaseToken,
          status: "DRY_RUN_COMPLETED",
          now: this.now()
        });
        outcomes.push({
          type: "AUTO_BOOST",
          clientId: client.id,
          phase: occurrence.phase,
          status: "DRY_RUN_COMPLETED"
        });
      } catch (error) {
        if (deliveryAttempted) {
          this.store.appendAuditEvent({
            eventType: "AUTO_BOOST_LINE_DELIVERY_FAILED",
            actorType: "SYSTEM",
            occurredAt: this.now(),
            details: {
              occurrenceId: occurrence.id,
              clientId: occurrence.clientId,
              phase: occurrence.phase,
              status: Number.isInteger(Number(error?.status)) ? Number(error.status) : null,
              retryable: error?.retryable !== false,
              error: String(error?.message ?? error).slice(0, 500)
            }
          });
          this.logger.error("auto boost LINE delivery failed", {
            occurrenceId: occurrence.id,
            phase: occurrence.phase,
            error: error?.message ?? error
          });
        }
        if (!deliveryAttempted) {
          try {
            this.store.finishAutoBoostOccurrence({
              id: occurrence.id,
              leaseToken: occurrence.leaseToken,
              status: "SKIPPED",
              now: this.now(),
              error: error?.message ?? error
            });
          } catch (finishError) {
            this.logger.error("auto boost skip finalization failed", {
              occurrenceId: occurrence.id,
              error: finishError?.message ?? finishError
            });
          }
        }
        outcomes.push({
          type: "AUTO_BOOST",
          clientId: occurrence.clientId,
          phase: occurrence.phase,
          status: deliveryAttempted ? "LINE_RETRY_PENDING" : "SKIPPED",
          error: safeError(error)
        });
      }
    }

    for (const subscription of this.store.claimDueReportSubscriptions({
      now: this.now(),
      limit: reportLimit
    })) {
      const client = this.#clientById(subscription.clientId);
      const itemNow = this.now();
      if (!client || !this.#isCurrentApprover(client, subscription.lineUserId)) {
        this.store.disableReportSubscription({
          clientId: subscription.clientId,
          lineUserId: subscription.lineUserId,
          now: itemNow
        });
        outcomes.push({
          type: "REPORT",
          clientId: subscription.clientId,
          status: "SKIP_NOT_AUTHORIZED"
        });
        continue;
      }
      const { snapshot, stale } = this.#latestControlSnapshot(client);
      const retryKey = stableRetryKey(
        "scheduled-report",
        client.id,
        subscription.lineUserId,
        subscription.occurrenceAt
      );
      try {
        await this.line.push(
          subscription.lineUserId,
          buildPerformanceReportMessage({ client, snapshot, stale, now: itemNow }),
          retryKey
        );
        this.store.completeReportOccurrence({
          clientId: client.id,
          lineUserId: subscription.lineUserId,
          occurrenceAt: subscription.occurrenceAt,
          now: this.now()
        });
        this.store.appendAuditEvent({
          eventType: "SCHEDULED_REPORT_SENT",
          actorType: "SYSTEM",
          occurredAt: this.now(),
          details: {
            clientId: client.id,
            occurrenceAt: subscription.occurrenceAt,
            snapshotId: snapshot?.snapshotId ?? null,
            stale,
            retryKey
          }
        });
        outcomes.push({ type: "REPORT", clientId: client.id, status: "SENT" });
      } catch (error) {
        // Advance this occurrence even on failure. This prevents a blocked LINE
        // user or permanent 4xx from being retried every 10 seconds forever.
        // The following scheduled occurrence remains active.
        this.store.completeReportOccurrence({
          clientId: client.id,
          lineUserId: subscription.lineUserId,
          occurrenceAt: subscription.occurrenceAt,
          now: this.now()
        });
        this.store.appendAuditEvent({
          eventType: "SCHEDULED_REPORT_FAILED",
          actorType: "SYSTEM",
          occurredAt: this.now(),
          details: {
            clientId: client.id,
            occurrenceAt: subscription.occurrenceAt,
            retryKey,
            error: String(error?.message ?? error).slice(0, 500),
            retryPolicy: "NEXT_INTERVAL"
          }
        });
        outcomes.push({ type: "REPORT", clientId: client.id, status: "FAILED_NEXT_INTERVAL" });
      }
    }
    return outcomes;
  }

  async #pushResult(userId, request, options) {
    const retryKey = stableRetryKey("budget-result", request.id, request.state, userId);
    try {
      await this.line.push(userId, buildResultMessage({ request: this.#view(request), ...options }), retryKey);
      this.store.appendAuditEvent({
        requestId: request.id,
        eventType: "LINE_RESULT_SENT",
        actorType: "SYSTEM",
        occurredAt: this.now(),
        details: { state: request.state, retryKey }
      });
    } catch (error) {
      this.store.appendAuditEvent({
        requestId: request.id,
        eventType: "LINE_RESULT_FAILED",
        actorType: "SYSTEM",
        occurredAt: this.now(),
        details: { state: request.state, retryKey, error: String(error?.message ?? error).slice(0, 500) }
      });
    }
  }

  async retryPendingResults({ limit = 1000 } = {}) {
    const outcomes = [];
    for (const state of [RequestState.SUCCEEDED, RequestState.FAILED, RequestState.CANCELLED]) {
      for (const request of this.store.listBudgetRequests({ state, limit })) {
        const cancellationNeedsResult = state === RequestState.CANCELLED && request.cancellation?.reason !== "Rejected in LINE";
        const userId = request.execution?.approvedByLineUserId ?? (
          cancellationNeedsResult ? request.cancellation?.actorLineUserId : null
        );
        if (!userId) continue;
        const alreadySent = this.store.listAuditEvents({ requestId: request.id, eventType: "LINE_RESULT_SENT", limit: 1000 })
          .some((event) => event.details.state === request.state);
        if (alreadySent) continue;
        await this.#pushResult(userId, request, {
          ok: state === RequestState.SUCCEEDED,
          dryRun: state === RequestState.CANCELLED && request.cancellation?.reason?.startsWith("Dry run:"),
          detail: state === RequestState.SUCCEEDED
            ? "ยืนยันจากงบจริงบน TikTok แล้ว"
            : state === RequestState.FAILED
              ? "โปรดตรวจ audit และงบจริงก่อนสร้างคำขอใหม่"
              : request.cancellation?.reason?.startsWith("Dry run:")
                ? "โหมดทดสอบ—ไม่มีการแก้งบจริง"
                : `ยกเลิกเพื่อความปลอดภัย: ${request.cancellation?.reason ?? "ข้อมูลเปลี่ยน"}`
        });
        outcomes.push({ requestId: request.id, state });
      }
    }
    return outcomes;
  }

  async executeApprovedRequest(requestId, userId) {
    let request = this.store.requireBudgetRequest(requestId);
    if (request.state !== RequestState.PENDING_APPROVAL) return request;

    if (telemetryOnlyRequest(request)) {
      request = this.store.cancelBudgetRequest(request.id, {
        actorLineUserId: userId,
        reason: "Dry run: telemetry-only execution blocked",
        now: this.now()
      });
      await this.#pushResult(userId, request, {
        ok: true,
        dryRun: true,
        detail: "คำขอ telemetry ไม่มีสิทธิ์เข้าถึง TikTok"
      });
      return request;
    }

    if (!this.executionEnabled) {
      request = this.store.cancelBudgetRequest(request.id, { actorLineUserId: userId, reason: "Dry run: EXECUTION_ENABLED=false", now: this.now() });
      await this.#pushResult(userId, request, { ok: true, dryRun: true, detail: "เปิด EXECUTION_ENABLED หลังผ่าน sandbox/low-budget test" });
      return request;
    }

    let claimed = false;
    let writeAttempted = false;
    let updateAccepted = false;
    try {
      const mapping = this.#currentExecutionMapping(request, userId);
      let info;
      if (mapping.dynamic) {
        const resolved = await this.#resolveDynamicCampaign(mapping.client);
        this.#assertDynamicAuthorityUnchanged(
          request.metadata.dynamicPolicy,
          resolved.campaign.dynamicPolicy
        );
        if (String(resolved.campaign.id) !== String(request.campaignId)) {
          throw new DomainError("DYNAMIC_CAMPAIGN_CHANGED", "Today's active LIVE campaign changed after the LINE request was created");
        }
        mapping.campaign = resolved.campaign;
        info = resolved.info;
      } else {
        info = await this.tiktok.getCampaignInfo({ advertiserId: request.adAccountId, campaignId: request.campaignId });
      }
      this.#assertCampaignIdentity(info, mapping.client, mapping.campaign);
      const observedMinor = toMinor(info.budget, request.currency);
      request = this.store.claimBudgetRequestForExecution(request.id, {
        actorLineUserId: userId,
        observedCurrentBudgetMinor: observedMinor,
        now: this.now()
      });
      claimed = true;

      if (mapping.dynamic) {
        const finalResolution = await this.#resolveDynamicCampaign(mapping.client);
        this.#assertDynamicAuthorityUnchanged(
          request.metadata.dynamicPolicy,
          finalResolution.campaign.dynamicPolicy
        );
        if (String(finalResolution.campaign.id) !== String(request.campaignId)) {
          throw new DomainError("DYNAMIC_CAMPAIGN_CHANGED", "Today's active LIVE campaign changed immediately before execution");
        }
        this.#assertCampaignIdentity(finalResolution.info, mapping.client, finalResolution.campaign);
        if (toMinor(finalResolution.info.budget, request.currency) !== request.currentBudgetMinor) {
          throw new DomainError("STALE_CURRENT_BUDGET", "TikTok budget changed immediately before execution");
        }
      }

      this.store.appendAuditEvent({
        requestId: request.id,
        eventType: "TIKTOK_UPDATE_ATTEMPTED",
        actorType: "SYSTEM",
        occurredAt: this.now(),
        details: { executionId: request.execution.id, targetBudgetMinor: request.targetBudgetMinor }
      });
      writeAttempted = true;
      const update = await this.tiktok.updateCampaignBudget({
        advertiserId: request.adAccountId,
        campaignId: request.campaignId,
        budget: fromMinor(request.targetBudgetMinor, request.currency)
      });
      updateAccepted = true;
      this.store.appendAuditEvent({
        requestId: request.id,
        eventType: "TIKTOK_UPDATE_ACCEPTED",
        actorType: "SYSTEM",
        occurredAt: this.now(),
        details: { requestId: update.requestId ?? null }
      });

      let verified;
      for (const waitMs of [0, 400, 1000]) {
        if (waitMs) await delay(waitMs);
        verified = await this.tiktok.getCampaignInfo({ advertiserId: request.adAccountId, campaignId: request.campaignId });
        this.#assertCampaignIdentity(verified, mapping.client, mapping.campaign);
        if (toMinor(verified.budget, request.currency) === request.targetBudgetMinor) break;
      }
      const verifiedMinor = toMinor(verified.budget, request.currency);
      request = this.store.succeedBudgetRequest(request.id, {
        actualBudgetMinor: verifiedMinor,
        platformReference: update.requestId,
        now: this.now()
      });
      await this.#pushResult(userId, request, { ok: true, detail: `TikTok request: ${update.requestId ?? "n/a"}` });
      return request;
    } catch (error) {
      const safe = safeError(error);
      request = this.store.getBudgetRequest(requestId) ?? request;
      const uncertainWrite = claimed && writeAttempted && request.state === RequestState.EXECUTING && (
        updateAccepted ||
        safe.outcomeKnown === false ||
        [
          "UNEXPECTED_PLATFORM_BUDGET",
          "ACCOUNT_MISMATCH",
          "CAMPAIGN_MISMATCH",
          "STORE_MISMATCH",
          "BUSINESS_CENTER_MISMATCH",
          "NOT_LIVE_GMV_MAX",
          "CAMPAIGN_NOT_ENABLED",
          "TIKTOK_ACCOUNT_MISMATCH",
          "TIKTOK_ACCOUNT_ID_AMBIGUOUS",
          "TIKTOK_ACCOUNT_ID_UNVERIFIED",
          "TIKTOK_MALFORMED_CAMPAIGN_INFO"
        ].includes(safe.code)
      );
      if (uncertainWrite) {
        this.store.appendAuditEvent({
          requestId: request.id,
          eventType: "TIKTOK_UPDATE_RECONCILIATION_REQUIRED",
          actorType: "SYSTEM",
          occurredAt: this.now(),
          details: { code: safe.code, requestId: safe.requestId, updateAccepted }
        });
        await this.#pushResult(userId, request, {
          ok: false,
          pending: true,
          detail: "ยังไม่สรุปว่าสำเร็จหรือล้มเหลว ระบบจะอ่านงบซ้ำและไม่เปิดคำขอใหม่ระหว่างนี้"
        });
        return request;
      }
      if (claimed && request.state === RequestState.EXECUTING) {
        request = this.store.failBudgetRequest(request.id, { code: safe.code, message: safe.message, retryable: false, now: this.now() });
      } else if ([
        "STALE_CURRENT_BUDGET",
        "ACCOUNT_MISMATCH",
        "CAMPAIGN_MISMATCH",
        "STORE_MISMATCH",
        "BUSINESS_CENTER_MISMATCH",
        "NOT_LIVE_GMV_MAX",
        "CAMPAIGN_NOT_ENABLED",
        "CONFIG_MAPPING_REVOKED",
        "APPROVER_REVOKED",
        "CONFIG_IDENTITY_CHANGED",
        "BUDGET_POLICY_CHANGED",
        "OUTSIDE_LIVE_WINDOW",
        "DYNAMIC_CAMPAIGN_CHANGED",
        "DYNAMIC_CAMPAIGN_AMBIGUOUS",
        "DYNAMIC_CAMPAIGN_NOT_FOUND",
        "DYNAMIC_CAMPAIGN_NAME_MISMATCH",
        "TIKTOK_ACCOUNT_MISMATCH",
        "TIKTOK_ACCOUNT_ID_AMBIGUOUS",
        "TIKTOK_ACCOUNT_ID_UNVERIFIED"
      ].includes(safe.code) && request.state === RequestState.PENDING_APPROVAL) {
        request = this.store.cancelBudgetRequest(request.id, { actorLineUserId: userId, reason: safe.code, now: this.now() });
      }
      await this.#pushResult(userId, request, { ok: false, detail: `${safe.code}: ${safe.message}` });
      return request;
    }
  }

  async processExecutionJobs({ maxJobs = 10 } = {}) {
    if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 100) {
      throw new Error("maxJobs must be an integer between 1 and 100");
    }
    this.expireOldRequests();
    const outcomes = [];
    for (let processed = 0; processed < maxJobs; processed += 1) {
      const claim = this.store.claimNextExecutionJob({
        claimedAt: this.now(),
        leaseDurationMs: 5 * 60_000
      });
      if (!claim) break;
      const { job } = claim;
      try {
        let request = this.store.requireBudgetRequest(job.requestId);
        if (request.state === RequestState.PENDING_APPROVAL) {
          request = await this.executeApprovedRequest(job.requestId, job.actorLineUserId);
        } else if (request.state === RequestState.EXECUTING) {
          await this.recoverExecutingRequests();
          request = this.store.requireBudgetRequest(job.requestId);
        }

        if ([RequestState.SUCCEEDED, RequestState.FAILED, RequestState.EXPIRED, RequestState.CANCELLED].includes(request.state)) {
          this.store.completeExecutionJob({
            requestId: job.requestId,
            leaseToken: job.leaseToken,
            completedAt: this.now()
          });
          outcomes.push({ requestId: job.requestId, status: "COMPLETED", requestState: request.state });
          continue;
        }

        const backoffSeconds = Math.min(60, 5 * (2 ** Math.min(job.attemptCount - 1, 4)));
        this.store.releaseExecutionJob({
          requestId: job.requestId,
          leaseToken: job.leaseToken,
          availableAt: new Date(this.now().getTime() + backoffSeconds * 1000),
          releasedAt: this.now(),
          error: { code: request.state === RequestState.EXECUTING ? "RECONCILING" : "RETRY_PENDING_APPROVAL" }
        });
        outcomes.push({ requestId: job.requestId, status: "RETRY_SCHEDULED", requestState: request.state });
      } catch (error) {
        const safe = safeError(error);
        try {
          this.store.releaseExecutionJob({
            requestId: job.requestId,
            leaseToken: job.leaseToken,
            availableAt: new Date(this.now().getTime() + 30_000),
            releasedAt: this.now(),
            error: safe
          });
        } catch (releaseError) {
          this.logger.error("execution job release failed", {
            requestId: job.requestId,
            code: releaseError?.code,
            message: releaseError?.message
          });
        }
        outcomes.push({ requestId: job.requestId, status: "ERROR", error: safe });
      }
    }
    return outcomes;
  }

  async recoverExecutingRequests() {
    const results = [];
    for (const request of this.store.listBudgetRequests({ state: RequestState.EXECUTING, limit: 1000 })) {
      try {
        if (telemetryOnlyRequest(request)) {
          const failed = this.store.failBudgetRequest(request.id, {
            code: "TELEMETRY_ONLY_REQUEST",
            message: "Telemetry dry-run request cannot reach TikTok",
            retryable: false,
            now: this.now()
          });
          await this.#pushResult(request.execution.approvedByLineUserId, failed, {
            ok: false,
            dryRun: true,
            detail: "ปิดคำขอ telemetry ที่เข้าสถานะ execution โดยไม่มีการเรียก TikTok"
          });
          results.push({ requestId: request.id, status: "FAILED_TELEMETRY_ONLY" });
          continue;
        }
        const mapping = this.#requestMapping(request);
        const info = await this.tiktok.getCampaignInfo({ advertiserId: request.adAccountId, campaignId: request.campaignId });
        this.#assertCampaignIdentity(info, mapping.client, mapping.campaign);
        const actualBudgetMinor = toMinor(info.budget, request.currency);
        if (actualBudgetMinor === request.targetBudgetMinor) {
          const succeeded = this.store.succeedBudgetRequest(request.id, {
            actualBudgetMinor,
            platformReference: "reconciled-after-uncertain-write",
            now: this.now()
          });
          await this.#pushResult(request.execution.approvedByLineUserId, succeeded, {
            ok: true,
            detail: "ตรวจสอบงบจริงซ้ำแล้วและยืนยันผลสำเร็จ"
          });
          results.push({ requestId: request.id, status: "SUCCEEDED" });
        } else {
          const reconcileUntil = Date.parse(request.execution.startedAt) + this.config.reconciliationWindowMinutes * 60_000;
          if (this.now().getTime() < reconcileUntil) {
            results.push({
              requestId: request.id,
              status: "RETRY_LATER",
              observedBudgetMinor: actualBudgetMinor,
              reconcileUntil: new Date(reconcileUntil).toISOString()
            });
            continue;
          }
          const failed = this.store.failBudgetRequest(request.id, {
            code: "RECOVERY_BUDGET_MISMATCH",
            message: "TikTok budget did not match the approved target within the reconciliation window",
            retryable: false,
            now: this.now()
          });
          await this.#pushResult(request.execution.approvedByLineUserId, failed, {
            ok: false,
            detail: "พ้นช่วงตรวจสอบแล้ว แต่งบจริงยังไม่ตรงกับยอดที่อนุมัติ"
          });
          results.push({ requestId: request.id, status: "FAILED" });
        }
      } catch (error) {
        results.push({ requestId: request.id, status: "RETRY_LATER", error: safeError(error) });
      }
    }
    return results;
  }
}

export { calculateSuggestedTarget };
