import { createHash } from 'node:crypto';
import { CREATOR_BINDING } from './creator-read.js';

// A single, explicitly dated test. This module does not enable general Auto,
// create campaigns, hold TikTok credentials, or use the read key for writes.
export const CREATOR_BUDGET_TEST_URL = 'https://gmv-max-report-production-3251.up.railway.app/internal/creator/punpan_020/budget-test';
export const CREATOR_BUDGET_TEST_CAMPAIGN = '1881130110195874';
const CLIENT = 'punpan_020';
const MAX_BYTES = 16_384;
const PERMIT_KEYS = ['permitId', 'clientId', 'binding', 'campaignId', 'expectedBudgetMinor', 'targetBudgetMinor', 'capMinor', 'policyRevision', 'localDate', 'notBefore', 'expiresAt', 'nativeAutoBudgetVerifiedOff', 'exclusiveWriterConfirmed'];
const API_STATUSES = new Set(['WAIT', 'REJECTED', 'ARMED', 'NOT_FOUND', 'SEND_RESERVED', 'SUCCEEDED', 'OUTCOME_UNKNOWN', 'FAILED_REJECTED', 'FAILED_NOT_SENT', 'RECONCILED_TARGET_OBSERVED', 'CONFLICT_OBSERVED']);
const bangkokDate = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
const fail = code => { throw new Error(code); };
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export function validateCreatorBudgetTestPermit(input) {
  if (!exactKeys(input, PERMIT_KEYS) || !/^[A-Za-z0-9_-]{8,100}$/.test(input.permitId ?? '')
    || input.clientId !== CLIENT || input.campaignId !== CREATOR_BUDGET_TEST_CAMPAIGN
    || !exactKeys(input.binding, Object.keys(CREATOR_BINDING))
    || Object.entries(CREATOR_BINDING).some(([key, value]) => input.binding[key] !== value)
    || input.expectedBudgetMinor !== 300_000 || input.targetBudgetMinor !== 360_000
    || input.capMinor !== 1_000_000 || input.policyRevision !== 1
    || input.nativeAutoBudgetVerifiedOff !== true || input.exclusiveWriterConfirmed !== true
    || !/^\d{4}-\d{2}-\d{2}$/.test(input.localDate ?? '')) fail('CREATOR_BUDGET_TEST_PERMIT_INVALID');
  const times = ['notBefore', 'expiresAt'].map(key => {
    const value = input[key];
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
      || !Number.isFinite(Date.parse(value))) fail('CREATOR_BUDGET_TEST_WINDOW_REQUIRED');
    return new Date(value).toISOString();
  });
  if (Date.parse(times[0]) >= Date.parse(times[1]) || times.some(time => bangkokDate(time) !== input.localDate)) fail('CREATOR_BUDGET_TEST_WINDOW_INVALID');
  return Object.freeze({
    permitId: input.permitId, clientId: CLIENT, binding: CREATOR_BINDING,
    campaignId: CREATOR_BUDGET_TEST_CAMPAIGN, expectedBudgetMinor: 300_000,
    targetBudgetMinor: 360_000, capMinor: 1_000_000, policyRevision: 1,
    localDate: input.localDate, notBefore: times[0], expiresAt: times[1],
    nativeAutoBudgetVerifiedOff: true, exclusiveWriterConfirmed: true,
  });
}

function sanitizeResponse(input, permitId) {
  if (!object(input) || input.permitId !== permitId || !API_STATUSES.has(input.status)
    || ![0, 1].includes(input.postCount)
    || ![true, false].includes(input.lockSafeToRelease)
    || !(input.providerAccepted === null || typeof input.providerAccepted === 'boolean')
    || !(input.observedBudgetMinor === null || (Number.isSafeInteger(input.observedBudgetMinor) && input.observedBudgetMinor >= 0))) {
    fail('CREATOR_BUDGET_TEST_RESPONSE_UNVERIFIED');
  }
  if (input.writeAttempted !== undefined && typeof input.writeAttempted !== 'boolean') fail('CREATOR_BUDGET_TEST_RESPONSE_UNVERIFIED');
  // Never store arbitrary upstream text, errors, credentials, or unknown fields.
  const reason = typeof input.reason === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(input.reason) ? input.reason : null;
  return Object.freeze({
    permitId, status: input.status, postCount: input.postCount,
    providerAccepted: input.providerAccepted, observedBudgetMinor: input.observedBudgetMinor,
    lockSafeToRelease: input.lockSafeToRelease,
    writeAttempted: input.writeAttempted ?? input.postCount === 1, reason,
  });
}

async function boundedJson(response) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BYTES) fail('CREATOR_BUDGET_TEST_RESPONSE_UNVERIFIED');
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    let size = 0;
    const chunks = [];
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel(); fail('CREATOR_BUDGET_TEST_RESPONSE_UNVERIFIED'); }
        chunks.push(Buffer.from(item.value));
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally { reader.releaseLock(); }
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_BYTES) fail('CREATOR_BUDGET_TEST_RESPONSE_UNVERIFIED');
  return JSON.parse(text);
}

const unknownResponse = permitId => ({ permitId, status: 'OUTCOME_UNKNOWN', postCount: null,
  providerAccepted: null, observedBudgetMinor: null, lockSafeToRelease: false, writeAttempted: true,
  reason: 'BRIDGE_RESPONSE_UNKNOWN' });

export class CreatorBudgetTestWorker {
  #enabled;
  #permit;
  #digest;
  #store;
  #key;
  #fetch;
  #clock;
  #snapshot;
  #notify;
  #inFlight = null;
  #status = 'disabled';
  #reason = null;
  constructor({ enabled = false, permit, key, readKey, url = CREATOR_BUDGET_TEST_URL, store,
    snapshot, fetchImpl = globalThis.fetch, clock = () => new Date(), notify } = {}) {
    this.#enabled = enabled === true;
    this.#store = store;
    this.#clock = clock;
    if (!this.#enabled) return;
    if (url !== CREATOR_BUDGET_TEST_URL) fail('CREATOR_BUDGET_TEST_URL_NOT_ALLOWED');
    if (typeof key !== 'string' || key.length < 43 || key.length > 512 || /[\s\u0000-\u001f\u007f]/.test(key)
      || typeof readKey !== 'string' || readKey.length < 43 || key === readKey) fail('CREATOR_BUDGET_TEST_DEDICATED_KEY_REQUIRED');
    if (!store || typeof store.beginCreatorBudgetTest !== 'function' || typeof fetchImpl !== 'function') fail('CREATOR_BUDGET_TEST_DEPENDENCIES_REQUIRED');
    if (snapshot !== undefined && typeof snapshot !== 'function') fail('CREATOR_BUDGET_TEST_SNAPSHOT_INVALID');
    if (notify !== undefined && typeof notify !== 'function') fail('CREATOR_BUDGET_TEST_NOTIFY_INVALID');
    this.#permit = validateCreatorBudgetTestPermit(permit);
    this.#digest = createHash('sha256').update(JSON.stringify(this.#permit)).digest('hex');
    this.#key = key;
    this.#fetch = fetchImpl;
    this.#snapshot = snapshot;
    this.#notify = notify;
    this.#status = 'armed-one-shot';
  }

  health() {
    const record = this.#permit && this.#store.getCreatorBudgetTest(this.#permit.permitId);
    return {
      enabled: this.#enabled, oneShot: true, status: this.#status, reason: this.#reason,
      clientId: CLIENT, campaignId: this.#permit?.campaignId ?? null,
      localDate: this.#permit?.localDate ?? null, notBefore: this.#permit?.notBefore ?? null,
      expiresAt: this.#permit?.expiresAt ?? null, state: record?.state ?? null,
      outcome: record?.apiStatus ?? null, policyLocked: record?.lockHeld ?? false,
      generalAutoOptimizationEnabled: false,
    };
  }

  async tick() {
    if (!this.#enabled) return this.health();
    if (this.#inFlight) return this.#inFlight;
    this.#inFlight = this.#tick().catch(() => {
      // Never surface raw transport/credential text through public health.
      this.#status = 'blocked';
      this.#reason = 'LOCAL_SAFETY_CHECK_FAILED';
      return this.health();
    }).finally(() => { this.#inFlight = null; });
    return this.#inFlight;
  }

  #setStatus(status, reason = null) { this.#status = status; this.#reason = reason; return this.health(); }

  async #tick() {
    const permit = this.#permit;
    const now = new Date(this.#clock());
    if (!Number.isFinite(now.getTime())) return this.#setStatus('blocked', 'CLOCK_INVALID');
    const record = this.#store.getCreatorBudgetTest(permit.permitId);
    if (record && record.permitDigest !== this.#digest) return this.#setStatus('blocked', 'PERMIT_CHANGED');
    if (record?.state === 'TERMINAL') {
      await this.#notifyResult(record, now);
      return this.#setStatus('completed', record.apiStatus);
    }
    // Never issue any bridge RPC before the date/start approved by the owner.
    if (now.getTime() < Date.parse(permit.notBefore) || bangkokDate(now) < permit.localDate) return this.#setStatus('waiting-for-window');
    if (record?.lockHeld) {
      await this.#recover(record, now);
      return this.health();
    }
    if (now.getTime() >= Date.parse(permit.expiresAt) || bangkokDate(now) !== permit.localDate) return this.#setStatus('expired', 'WINDOW_EXPIRED');
    if (this.#snapshot) {
      let entry;
      try { entry = await this.#snapshot(CLIENT); } catch { return this.#setStatus('waiting-for-data', 'SNAPSHOT_UNAVAILABLE'); }
      const value = entry?.snapshot;
      const age = now.getTime() - Date.parse(value?.observedAt);
      if (!entry || entry.stale !== false || !value || value.unavailable || value.noActiveCampaign
        || value.clientId !== CLIENT || value.source !== 'tiktok-creator-api' || value.readOnly !== true
        || value.advertiserId !== CREATOR_BINDING.advertiserId || value.tiktokAccountId !== CREATOR_BINDING.tiktokAccountId
        || value.reportingDate !== permit.localDate || !Number.isFinite(age) || age < -30_000 || age > 180_000) {
        return this.#setStatus('waiting-for-data', 'FRESH_CREATOR_SNAPSHOT_REQUIRED');
      }
      if (value.campaignId !== permit.campaignId || value.dailyBudgetMinor !== permit.expectedBudgetMinor
        || value.campaignStatus !== 'ACTIVE' || ['ENABLED', 'CONFLICT'].includes(value.nativeAutoBudgetState)) {
        return this.#setStatus('blocked', 'CAMPAIGN_BASELINE_CHANGED');
      }
      if (!Number.isSafeInteger(value.costMinor) || value.costMinor < 0) return this.#setStatus('waiting-for-data', 'SPEND_UNAVAILABLE');
      if (BigInt(value.costMinor) * 10_000n < BigInt(permit.expectedBudgetMinor) * 8_000n) return this.#setStatus('waiting-for-threshold');
    }
    let claimed;
    try { claimed = this.#store.beginCreatorBudgetTest({ permit, permitDigest: this.#digest, now: this.#clock() }); }
    catch (error) {
      const allowed = new Set(['CREATOR_BUDGET_TEST_POLICY_CHANGED', 'CREATOR_BUDGET_TEST_OWNER_UNVERIFIED', 'CREATOR_BUDGET_TEST_IN_FLIGHT', 'CREATOR_BUDGET_TEST_DAY_CONFLICT', 'CREATOR_BUDGET_TEST_PERMIT_CONFLICT']);
      return this.#setStatus('blocked', allowed.has(error?.code) ? error.code : 'LOCAL_SAFETY_CHECK_FAILED');
    }
    if (!claimed.dispatch) {
      if (claimed.record.lockHeld) await this.#recover(claimed.record, now);
      return this.health();
    }
    const body = Object.fromEntries(['permitId', 'policyRevision', 'campaignId', 'expectedBudgetMinor', 'targetBudgetMinor', 'capMinor'].map(key => [key, permit[key]]));
    let response;
    try { response = await this.#request('POST', CREATOR_BUDGET_TEST_URL, body); }
    catch { response = unknownResponse(permit.permitId); }
    const finished = this.#store.recordCreatorBudgetTestResponse({ permitId: permit.permitId, response, now: this.#clock() });
    await this.#notifyResult(finished, now);
    return this.#setStatus(finished.state === 'WAITING' ? 'waiting-for-api-preflight' : finished.lockHeld ? 'outcome-unknown' : 'completed', finished.apiStatus);
  }

  async #request(method, url, body) {
    if (method === 'POST' && url === CREATOR_BUDGET_TEST_URL) {
      const now = new Date(this.#clock());
      if (!Number.isFinite(now.getTime()) || bangkokDate(now) !== this.#permit.localDate
        || now.getTime() < Date.parse(this.#permit.notBefore) || now.getTime() >= Date.parse(this.#permit.expiresAt)) fail('CREATOR_BUDGET_TEST_OUTSIDE_WINDOW');
    }
    const result = await this.#fetch(url, {
      method, redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { 'X-Creator-Budget-Test-Key': this.#key, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    // Auth errors, 5xx, missing records and redirects never prove no write.
    const payload = await boundedJson(result);
    const response = sanitizeResponse(payload, this.#permit.permitId);
    if (result.ok !== true && !(result.status >= 400 && result.status < 500 && response.status === 'REJECTED'
      && response.postCount === 0 && response.writeAttempted === false && response.lockSafeToRelease === true)) fail('CREATOR_BUDGET_TEST_HTTP_UNKNOWN');
    return response;
  }

  async #recover(record, now) {
    let response;
    const path = `${CREATOR_BUDGET_TEST_URL}/${encodeURIComponent(this.#permit.permitId)}`;
    try {
      response = await this.#request('GET', path);
      // GET ARM/NOT_FOUND may race the original in-flight request: never resend.
      if (['SEND_RESERVED', 'OUTCOME_UNKNOWN'].includes(response.status)) {
        response = await this.#request('POST', `${path}/reconcile`);
      }
    } catch { response = unknownResponse(this.#permit.permitId); }
    const result = this.#store.recordCreatorBudgetTestResponse({ permitId: record.permitId, response, now: this.#clock() });
    await this.#notifyResult(result, now);
    this.#setStatus(result.state === 'WAITING' ? 'waiting-for-api-preflight' : result.lockHeld ? 'outcome-unknown' : 'completed', result.apiStatus);
  }

  async #notifyResult(record, now) {
    if (!this.#notify || !record?.response || record.state === 'WAITING' || record.state === 'SENDING') return;
    const status = record.apiStatus;
    let message;
    if (status === 'SUCCEEDED' && record.state === 'TERMINAL') {
      message = 'ทดสอบ Ppan: TikTok ยืนยันปรับงบ 3,000 → 3,600 บาทแล้ว (+20%) เป็นการทดสอบครั้งเดียว ยังไม่เปิด Auto ต่อเนื่อง';
    } else if (status === 'RECONCILED_TARGET_OBSERVED') {
      message = 'ทดสอบ Ppan: ตรวจพบงบ 3,600 บาท แต่ยังยืนยันไม่ได้ว่าเกิดจากคำสั่งนี้ ระบบจะไม่ส่งเพิ่มซ้ำและยังล็อกการเปลี่ยนเพดานไว้รอตรวจสอบ';
    } else if (record.lockHeld) {
      message = 'ทดสอบ Ppan: ยังยืนยันผลปรับงบไม่ได้ ระบบจะตรวจสถานะอย่างเดียว ไม่ส่งเพิ่มซ้ำ และล็อกการเปลี่ยนเพดานไว้รอตรวจสอบ';
    } else {
      message = 'ทดสอบ Ppan: คำสั่งไม่สำเร็จหรือถูกปฏิเสธ ระบบหยุดการทดสอบแล้วและจะไม่เปิด Auto ต่อเนื่อง';
    }
    const recipient = this.#store.claimCreatorBudgetTestNotification({ permitId: record.permitId, status, now });
    if (!recipient) return;
    try { await this.#notify({ ...recipient, permitId: record.permitId, status, observedBudgetMinor: record.response.observedBudgetMinor, message, automaticRetry: false }); }
    catch { /* The durable claim intentionally prevents duplicate uncertain deliveries. */ }
  }
}

export function creatorBudgetTestFromEnvironment(environment = process.env, options = {}) {
  if (environment.CREATOR_BUDGET_TEST_ENABLED !== 'true') return null;
  let permit;
  try { permit = JSON.parse(environment.CREATOR_BUDGET_TEST_PERMIT ?? ''); }
  catch { fail('CREATOR_BUDGET_TEST_PERMIT_REQUIRED'); }
  return new CreatorBudgetTestWorker({
    ...options, enabled: true, permit,
    key: environment.CREATOR_BUDGET_TEST_KEY, readKey: environment.CREATOR_READ_BRIDGE_KEY,
    url: environment.CREATOR_BUDGET_TEST_URL ?? CREATOR_BUDGET_TEST_URL,
  });
}
