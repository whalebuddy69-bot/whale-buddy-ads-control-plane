import { createHash } from "node:crypto";
import { CREATOR_AUTOMATION_WEB_URL } from "./creator-policy.js";
import { creatorAutomationLineLabel, retryableCreatorAutoLineError, validCreatorLineRecipient } from "./creator-web-auto-line.js";

const CLIENT = "punpan_020";
export const PPAN_AUTO_WATCH_URL = "https://gmv-max-report-production-3251.up.railway.app/internal/creator/punpan_020/auto-watch";
const UPSTREAM_KINDS = new Set(["OUTCOME_UNKNOWN", "HEARTBEAT_STALE", "CHECKS_FAILING"]);
export const PPAN_AUTO_WATCH_ALERT_KINDS = Object.freeze([...UPSTREAM_KINDS, "WATCH_UNAVAILABLE"]);
export const PPAN_AUTO_WATCH_STALE_MS = 3 * 60_000;
export const PPAN_AUTO_WATCH_RECENT_MS = 30 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const validUuid = (value) => typeof value === "string" && UUID.test(value);
const keys = (value, expected) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));

export function validPpanAutoWatchAlert(value) {
  return keys(value, ["kind", "sessionId", "incidentKey"]) && PPAN_AUTO_WATCH_ALERT_KINDS.includes(value.kind) &&
    validUuid(value.sessionId) && (value.kind === "OUTCOME_UNKNOWN" ? validUuid(value.incidentKey) :
      typeof value.incidentKey === "string" && /^\d{1,18}$/.test(value.incidentKey));
}
export function validatePpanAutoWatch(value) {
  if (!keys(value, ["schemaVersion", "clientId", "armState", "sessionId", "incident"]) || value.schemaVersion !== 1 || value.clientId !== CLIENT ||
    (value.armState !== "ACTIVE" && value.armState !== "INACTIVE") ||
    !(validUuid(value.sessionId) || (value.armState === "INACTIVE" && value.sessionId === null)) ||
    !(value.incident === null || (validPpanAutoWatchAlert(value.incident) && UPSTREAM_KINDS.has(value.incident.kind) &&
      value.incident.sessionId === value.sessionId && (value.armState === "ACTIVE" || value.incident.kind === "OUTCOME_UNKNOWN")))) {
    throw new Error("PPAN_AUTO_WATCH_UNVERIFIED");
  }
  return { armState: value.armState, sessionId: value.sessionId, incident: value.incident };
}

async function smallJson(response) {
  const max = 2048, declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > max || !response.body?.getReader) throw new Error("PPAN_AUTO_WATCH_UNVERIFIED");
  const reader = response.body.getReader(), chunks = [];
  let total = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > max) { void reader.cancel().catch(() => undefined); throw new Error("PPAN_AUTO_WATCH_UNVERIFIED"); }
      chunks.push(Buffer.from(part.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { reader.releaseLock(); }
}

export async function readPpanAutoWatch({ key, fetchImpl = globalThis.fetch }) {
  if (typeof key !== "string" || key.length < 43) throw new Error("PPAN_AUTO_WATCH_UNVERIFIED");
  const response = await fetchImpl(PPAN_AUTO_WATCH_URL, { method: "GET", redirect: "error", signal: AbortSignal.timeout(8_000),
    headers: { "X-Creator-Read-Key": key, Accept: "application/json", "Cache-Control": "no-store" } });
  if (!response.ok) throw new Error("PPAN_AUTO_WATCH_UNAVAILABLE");
  return validatePpanAutoWatch(await smallJson(response));
}

const ALERT_COPY = Object.freeze({
  OUTCOME_UNKNOWN: "ยังยืนยันผลคำสั่ง Auto จาก TikTok ไม่ได้ ระบบระงับรายการใหม่และจะไม่ส่งซ้ำ",
  HEARTBEAT_STALE: "ไม่เห็นรอบตรวจ Auto สำเร็จเกิน 3 นาที โปรดตรวจสถานะก่อนใช้ Auto ต่อ",
  CHECKS_FAILING: "ระบบยังอ่านหรือยืนยันข้อมูลสำหรับ Auto ไม่ได้ต่อเนื่อง โปรดตรวจสถานะ",
  WATCH_UNAVAILABLE: "ติดต่อระบบตรวจ Auto ไม่ได้เกิน 3 นาที สถานะที่ตรวจได้ครั้งล่าสุดคือเปิด Auto อยู่",
});

/** Independent Render notification only. No budget/approval or TikTok API calls. */
export async function processPpanAutoWatch({ read, store, line, resolveOwner, clock = () => new Date(), logger = console }) {
  let snapshot, alert;
  try { snapshot = await read(); }
  catch { alert = store.getPpanAutoWatchOutage({ now: clock() }); }
  if (snapshot) {
    store.recordPpanAutoWatchContact({ armState: snapshot.armState, sessionId: snapshot.sessionId, now: clock() });
    alert = snapshot.incident;
  }
  if (!validPpanAutoWatchAlert(alert)) return null;
  const owner = resolveOwner();
  if (!validCreatorLineRecipient(owner)) return null;
  const ownerHash = createHash("sha256").update(owner).digest("hex");
  const claim = store.claimPpanAutoWatchAlert({ alert, ownerHash, now: clock() });
  if (!claim || resolveOwner() !== owner || Date.parse(claim.expiresAt) <= clock().getTime()) return null;
  let outcome = "ACCEPTED";
  try { await line.push(owner, { type: "text", text: `⚠️ ${creatorAutomationLineLabel(CLIENT)} — ${ALERT_COPY[alert.kind]}\nดูรายละเอียด: ${CREATOR_AUTOMATION_WEB_URL}` }, claim.retryKey); }
  catch (error) { outcome = retryableCreatorAutoLineError(error) ? "RETRYABLE" : "UNCONFIRMED"; }
  const result = store.finishPpanAutoWatchAlert({ alert, claimToken: claim.claimToken, outcome, now: clock() });
  if (!result) return null;
  const event = { event: "creator_ppan_auto_watch", kind: alert.kind, status: result === "ACCEPTED" ? "LINE_ACCEPTED" :
    result === "PENDING" ? "LINE_RETRY_PENDING" : "LINE_UNCONFIRMED" };
  logger.info?.(JSON.stringify(event));
  return event;
}
