import {
  ALARM_NAME,
  CONTROL_PLANE_ORIGIN,
  DASHBOARD,
  ENDPOINTS,
  MESSAGE_TYPES,
  PILOT_BINDING,
  STORAGE_KEYS,
  UI_SCHEMA_FINGERPRINT
} from "./lib/constants.js";
import {
  exportPublicKeyJwk,
  randomBase64Url,
  signRequest,
  telemetryUiCampaignRef
} from "./lib/auth.js";
import { getDeviceKeyPair, getOrCreateDeviceKeyPair } from "./lib/idb.js";

class CollectorFailure extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CollectorFailure";
    this.code = code;
  }
}

let activeCheck = null;

async function protectExtensionStorage() {
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
}

function normalizeText(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function safeError(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "COLLECTOR_ERROR",
    message: typeof error?.message === "string" ? error.message : "ตรวจหน้า TikTok ไม่สำเร็จ"
  };
}

async function readStatus() {
  await protectExtensionStorage();
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.status,
    STORAGE_KEYS.credential,
    STORAGE_KEYS.installationId
  ]);
  const credential = stored[STORAGE_KEYS.credential] ?? null;
  return {
    mode: credential ? "ready" : "not_enrolled",
    message: credential ? "เชื่อมต่อแล้ว รอตรวจหน้า TikTok" : "ยังไม่ได้เชื่อมต่อกับ Whale Buddy Ads",
    ...stored[STORAGE_KEYS.status],
    enrolled: Boolean(credential),
    clientId: credential?.clientId ?? PILOT_BINDING.clientId,
    browserProfile: credential?.browserProfile ?? PILOT_BINDING.browserProfile,
    tabGroup: credential?.tabGroup ?? PILOT_BINDING.tabGroup,
    installationId: stored[STORAGE_KEYS.installationId] ?? null
  };
}

async function updateStatus(patch) {
  await protectExtensionStorage();
  const current = (await chrome.storage.local.get(STORAGE_KEYS.status))[STORAGE_KEYS.status] ?? {};
  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString()
  };
  await chrome.storage.local.set({ [STORAGE_KEYS.status]: next });
  return next;
}

async function installationId() {
  await protectExtensionStorage();
  const stored = await chrome.storage.local.get(STORAGE_KEYS.installationId);
  if (stored[STORAGE_KEYS.installationId]) return stored[STORAGE_KEYS.installationId];
  const created = `install_${crypto.randomUUID()}`;
  await chrome.storage.local.set({ [STORAGE_KEYS.installationId]: created });
  return created;
}

async function parseResponse(response) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new CollectorFailure("SERVER_RESPONSE_INVALID", "เซิร์ฟเวอร์ตอบกลับในรูปแบบที่อ่านไม่ได้");
  }
  if (!response.ok || payload?.ok !== true) {
    const code = typeof payload?.error === "string" ? payload.error : `HTTP_${response.status}`;
    const message = typeof payload?.message === "string"
      ? payload.message
      : response.status === 401
        ? "สิทธิ์เชื่อมต่อไม่ถูกต้องหรือหมดอายุ"
        : "เซิร์ฟเวอร์ยังรับข้อมูลไม่ได้";
    throw new CollectorFailure(code, message);
  }
  return payload;
}

async function enroll(enrollmentCode) {
  await protectExtensionStorage();
  const code = String(enrollmentCode ?? "").trim();
  if (!/^[A-Za-z0-9_-]{43}$/u.test(code)) {
    throw new CollectorFailure("INVALID_ENROLLMENT_CODE", "รหัสเชื่อมต่อต้องมี 43 ตัวอักษร");
  }

  await updateStatus({ mode: "working", message: "กำลังเชื่อมต่ออย่างปลอดภัย…", errorCode: null });
  const keyPair = await getOrCreateDeviceKeyPair();
  const publicKeyJwk = await exportPublicKeyJwk(keyPair.publicKey);
  const currentInstallationId = await installationId();
  let response;
  try {
    response = await fetch(`${CONTROL_PLANE_ORIGIN}${ENDPOINTS.enroll}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: PILOT_BINDING.clientId,
        enrollmentCode: code,
        installationId: currentInstallationId,
        publicKeyJwk
      }),
      cache: "no-store",
      credentials: "omit",
      redirect: "error"
    });
  } catch {
    throw new CollectorFailure("SERVER_UNREACHABLE", "เชื่อมต่อ Render ไม่สำเร็จ กรุณาตรวจอินเทอร์เน็ต");
  }
  const payload = await parseResponse(response);
  if (
    !/^tc_[A-Za-z0-9_-]{16,80}$/u.test(payload.credentialId ?? "") ||
    payload.clientId !== PILOT_BINDING.clientId ||
    payload.binding?.browserProfile !== PILOT_BINDING.browserProfile ||
    payload.binding?.tabGroup !== PILOT_BINDING.tabGroup
  ) {
    throw new CollectorFailure("ENROLLMENT_BINDING_MISMATCH", "ข้อมูลบัญชีจากเซิร์ฟเวอร์ไม่ตรง Pilot นี้");
  }
  const credential = {
    credentialId: payload.credentialId,
    clientId: payload.clientId,
    installationId: currentInstallationId,
    browserProfile: payload.binding.browserProfile,
    tabGroup: payload.binding.tabGroup,
    enrolledAt: new Date().toISOString()
  };
  await chrome.storage.local.set({ [STORAGE_KEYS.credential]: credential });
  await updateStatus({
    mode: "ready",
    message: "เชื่อมต่อแล้ว พร้อมอ่านหน้า TikTok แบบ read-only",
    errorCode: null,
    enrolledAt: credential.enrolledAt
  });
  await ensureAlarm();
  return readStatus();
}

function timePartsInBangkok(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: PILOT_BINDING.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Number(values.hour) * 60 + Number(values.minute);
}

function dateInBangkok(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: PILOT_BINDING.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function withinLiveWindow(now = new Date()) {
  const [startHour, startMinute] = PILOT_BINDING.liveWindow.start.split(":").map(Number);
  const [endHour, endMinute] = PILOT_BINDING.liveWindow.end.split(":").map(Number);
  const current = timePartsInBangkok(now);
  const start = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;
  return start < end ? current >= start && current < end : current >= start || current < end;
}

function supportedDashboardUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.origin === DASHBOARD.origin && url.pathname === DASHBOARD.pathname;
  } catch {
    return false;
  }
}

function requireExactParameter(url, name, expected) {
  const values = url.searchParams.getAll(name);
  if (values.length !== 1 || values[0] !== expected) {
    throw new CollectorFailure("URL_IDENTITY_MISMATCH", `หน้า TikTok มี ${name} ไม่ตรงบัญชีที่กำหนด`);
  }
}

function validateDashboardUrl(rawUrl) {
  const url = new URL(rawUrl);
  requireExactParameter(url, "aadvid", PILOT_BINDING.advertiserId);
  requireExactParameter(url, "bc_id", PILOT_BINDING.businessCenterId);
  requireExactParameter(url, "oec_seller_id", PILOT_BINDING.sellerMode);
  requireExactParameter(url, "type", PILOT_BINDING.pageType);
}

async function readTikTokObservation(credential) {
  const groups = await chrome.tabGroups.query({});
  const matchingGroups = groups.filter((group) => normalizeText(group.title) === credential.tabGroup);
  if (matchingGroups.length === 0) {
    throw new CollectorFailure("GROUP_NOT_FOUND", `ไม่พบกลุ่มแท็บ ${credential.tabGroup}`);
  }
  if (matchingGroups.length !== 1) {
    throw new CollectorFailure("GROUP_AMBIGUOUS", `พบกลุ่มแท็บ ${credential.tabGroup} มากกว่าหนึ่งกลุ่ม`);
  }

  const tabs = await chrome.tabs.query({ groupId: matchingGroups[0].id });
  const dashboards = tabs.filter((tab) => supportedDashboardUrl(tab.url));
  if (dashboards.length === 0) {
    throw new CollectorFailure("SUPPORTED_TAB_NOT_FOUND", "ไม่พบหน้า LIVE GMV Max ในกลุ่ม Ppan");
  }
  if (dashboards.length !== 1) {
    throw new CollectorFailure("SUPPORTED_TAB_AMBIGUOUS", "พบหน้า LIVE GMV Max มากกว่าหนึ่งแท็บในกลุ่ม Ppan");
  }
  const tab = dashboards[0];
  if (tab.status !== "complete" || tab.discarded === true || tab.frozen === true) {
    throw new CollectorFailure("TAB_NOT_READY", "แท็บ TikTok ยังไม่พร้อม กรุณาเปิดแท็บไว้แล้วลองใหม่");
  }
  validateDashboardUrl(tab.url);

  let response;
  try {
    response = await chrome.tabs.sendMessage(tab.id, {
      type: MESSAGE_TYPES.collect,
      binding: {
        advertiserId: PILOT_BINDING.advertiserId,
        businessCenterId: PILOT_BINDING.businessCenterId,
        expectedTikTokAccountId: PILOT_BINDING.expectedTikTokAccountId,
        campaignStart: `${PILOT_BINDING.liveWindow.start}:00`,
        sellerMode: PILOT_BINDING.sellerMode,
        pageType: PILOT_BINDING.pageType
      }
    });
  } catch {
    throw new CollectorFailure(
      "CONTENT_SCRIPT_UNAVAILABLE",
      "ตัวอ่านยังไม่อยู่ในแท็บ TikTok กรุณารีโหลดแท็บหนึ่งครั้ง"
    );
  }
  if (response?.ok !== true) {
    throw new CollectorFailure(
      response?.error?.code ?? "COLLECTOR_ERROR",
      response?.error?.message ?? "อ่านหน้า TikTok ไม่สำเร็จ"
    );
  }
  const value = response.observation;
  const moneyFields = ["dailyBudgetMinor", "totalBudgetMinor", "costMinor", "netCostMinor"];
  const observedMilliseconds = Date.parse(value?.observedAt);
  const expectedCampaignName = `${dateInBangkok()} ${PILOT_BINDING.liveWindow.start}:00`;
  const maximumMoneyMinor = 100_000_000_000;
  if (
    !value ||
    value.campaignStatus !== "ACTIVE" ||
    value.tiktokAccountId !== PILOT_BINDING.expectedTikTokAccountId ||
    value.currency !== PILOT_BINDING.currency ||
    value.campaignName !== expectedCampaignName ||
    !moneyFields.every((field) =>
      Number.isSafeInteger(value[field]) &&
      value[field] >= 0 &&
      value[field] <= maximumMoneyMinor
    ) ||
    value.dailyBudgetMinor <= 0 ||
    value.totalBudgetMinor <= 0 ||
    !Number.isFinite(observedMilliseconds) ||
    Math.abs(Date.now() - observedMilliseconds) > 60_000
  ) {
    throw new CollectorFailure("COLLECTOR_RESPONSE_INVALID", "ตัวอ่านส่งข้อมูลที่ไม่ครบถ้วน");
  }
  return value;
}

async function buildSnapshot(observation, credential) {
  return {
    schemaVersion: 1,
    uiSchemaFingerprint: UI_SCHEMA_FINGERPRINT,
    snapshotId: `ts_${crypto.randomUUID()}`,
    clientId: credential.clientId,
    advertiserId: PILOT_BINDING.advertiserId,
    businessCenterId: PILOT_BINDING.businessCenterId,
    sellerMode: PILOT_BINDING.sellerMode,
    pageType: PILOT_BINDING.pageType,
    tiktokAccountId: PILOT_BINDING.expectedTikTokAccountId,
    // The live table exposes no campaign_id, row attribute, link, or hidden
    // identifier. Never invent one or inspect TikTok internal application state.
    // Render may resolve the real ID later through the official TikTok API.
    campaignId: null,
    campaignRef: await telemetryUiCampaignRef({
      advertiserId: PILOT_BINDING.advertiserId,
      campaignName: observation.campaignName
    }),
    campaignName: observation.campaignName,
    campaignType: "LIVE_GMV_MAX",
    campaignStatus: "ACTIVE",
    currency: PILOT_BINDING.currency,
    dailyBudgetMinor: observation.dailyBudgetMinor,
    totalBudgetMinor: observation.totalBudgetMinor,
    costMinor: observation.costMinor,
    netCostMinor: observation.netCostMinor,
    observedAt: new Date(observation.observedAt).toISOString(),
    source: {
      browserProfile: credential.browserProfile,
      tabGroup: credential.tabGroup
    }
  };
}

async function sendSnapshot(snapshot, credential) {
  const keys = await getDeviceKeyPair();
  if (!keys?.privateKey) {
    throw new CollectorFailure("DEVICE_KEY_MISSING", "ไม่พบกุญแจของโปรไฟล์นี้ กรุณาเชื่อมต่อใหม่");
  }
  const rawBody = new TextEncoder().encode(JSON.stringify(snapshot));
  const auth = await signRequest({
    privateKey: keys.privateKey,
    credentialId: credential.credentialId,
    rawBody
  });
  let response;
  try {
    response = await fetch(`${CONTROL_PLANE_ORIGIN}${ENDPOINTS.snapshots}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-WB-Telemetry-Credential": credential.credentialId,
        "X-WB-Telemetry-Timestamp": auth.timestamp,
        "X-WB-Telemetry-Nonce": auth.nonce,
        "X-WB-Telemetry-Signature": auth.signature
      },
      body: rawBody,
      cache: "no-store",
      credentials: "omit",
      redirect: "error"
    });
  } catch {
    throw new CollectorFailure("SERVER_UNREACHABLE", "ส่งข้อมูลไป Render ไม่สำเร็จ กรุณาตรวจอินเทอร์เน็ต");
  }
  return parseResponse(response);
}

async function acquireLease() {
  await protectExtensionStorage();
  const now = Date.now();
  const current = (await chrome.storage.local.get(STORAGE_KEYS.lease))[STORAGE_KEYS.lease];
  if (current?.until > now) return null;
  const lease = { holder: randomBase64Url(12), until: now + 45_000 };
  await chrome.storage.local.set({ [STORAGE_KEYS.lease]: lease });
  const verified = (await chrome.storage.local.get(STORAGE_KEYS.lease))[STORAGE_KEYS.lease];
  return verified?.holder === lease.holder ? lease : null;
}

async function releaseLease(lease) {
  const current = (await chrome.storage.local.get(STORAGE_KEYS.lease))[STORAGE_KEYS.lease];
  if (current?.holder === lease?.holder) {
    await chrome.storage.local.remove(STORAGE_KEYS.lease);
  }
}

async function runCheck({ manual = false } = {}) {
  if (activeCheck) return activeCheck;
  activeCheck = (async () => {
    await protectExtensionStorage();
    const stored = await chrome.storage.local.get(STORAGE_KEYS.credential);
    const credential = stored[STORAGE_KEYS.credential];
    if (!credential) {
      throw new CollectorFailure("NOT_ENROLLED", "ยังไม่ได้เชื่อมต่อ กรุณาใส่รหัสเชื่อมต่อก่อน");
    }
    if (!manual && !withinLiveWindow()) {
      await updateStatus({
        mode: "waiting",
        message: "อยู่นอกช่วง LIVE 06:00–23:00 น. ระบบจะรอตรวจรอบถัดไป",
        errorCode: null,
        lastAttemptAt: new Date().toISOString()
      });
      return { skipped: true, reason: "OUTSIDE_LIVE_WINDOW" };
    }
    const lease = await acquireLease();
    if (!lease) return { skipped: true, reason: "CHECK_IN_PROGRESS" };
    try {
      await updateStatus({
        mode: "working",
        message: "กำลังอ่านหน้า TikTok แบบ read-only…",
        errorCode: null,
        lastAttemptAt: new Date().toISOString()
      });
      const observation = await readTikTokObservation(credential);
      const snapshot = await buildSnapshot(observation, credential);
      const accepted = await sendSnapshot(snapshot, credential);
      await updateStatus({
        mode: "healthy",
        message: "ส่งข้อมูลล่าสุดไป Whale Buddy Ads แล้ว",
        errorCode: null,
        lastSuccessAt: new Date().toISOString(),
        lastSnapshot: {
          snapshotId: accepted.snapshotId,
          observedAt: accepted.observedAt,
          campaignName: snapshot.campaignName,
          dailyBudgetMinor: snapshot.dailyBudgetMinor,
          costMinor: snapshot.costMinor,
          currency: snapshot.currency
        }
      });
      return { ok: true, snapshotId: accepted.snapshotId };
    } catch (error) {
      const safe = safeError(error);
      await updateStatus({
        mode: "error",
        message: safe.message,
        errorCode: safe.code,
        lastAttemptAt: new Date().toISOString()
      });
      throw error;
    } finally {
      await releaseLease(lease);
    }
  })();
  try {
    return await activeCheck;
  } finally {
    activeCheck = null;
  }
}

async function ensureAlarm() {
  const alarm = await chrome.alarms.get(ALARM_NAME);
  if (!alarm) await chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
}

function trustedUiSender(sender) {
  const allowed = new Set([
    chrome.runtime.getURL("ui/popup.html"),
    chrome.runtime.getURL("ui/options.html")
  ]);
  return allowed.has(sender?.url);
}

chrome.runtime.onInstalled.addListener((details) => {
  void (async () => {
    await protectExtensionStorage();
    await installationId();
    await ensureAlarm();
    if (details.reason === "install") await chrome.runtime.openOptionsPage();
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    await protectExtensionStorage();
    await ensureAlarm();
    await runCheck().catch(() => {});
  })();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) void runCheck().catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!trustedUiSender(sender)) return false;
  if (message?.type === MESSAGE_TYPES.getStatus) {
    readStatus().then(sendResponse).catch((error) => sendResponse({
      mode: "error",
      message: safeError(error).message,
      errorCode: safeError(error).code
    }));
    return true;
  }
  if (message?.type === MESSAGE_TYPES.enroll) {
    enroll(message.enrollmentCode)
      .then((status) => sendResponse({ ok: true, status }))
      .catch(async (error) => {
        const safe = safeError(error);
        await updateStatus({ mode: "error", message: safe.message, errorCode: safe.code });
        sendResponse({ ok: false, error: safe });
      });
    return true;
  }
  if (message?.type === MESSAGE_TYPES.checkNow) {
    runCheck({ manual: true })
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: safeError(error) }));
    return true;
  }
  return false;
});

void (async () => {
  await protectExtensionStorage();
  await ensureAlarm();
})();
