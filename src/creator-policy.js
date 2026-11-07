import { createHash } from 'node:crypto';
import { DomainError } from './domain.js';

export const CREATOR_POLICY_DEFAULTS = Object.freeze({
  clientId: 'punpan_020',
  timezone: 'Asia/Bangkok',
  thresholdBps: 8000,
  increaseBps: 2000,
  capMinor: 1_000_000,
  mode: 'AUTO_PENDING_TEST',
  executionEnabled: false,
});
export const CREATOR_CAP_TTL_MS = 15 * 60_000;
export const CREATOR_AUTOMATION_WEB_URL = 'https://report.whalebuddy69.com/automation';
export const SRIHIW_CREATOR_POLICY_CLIENT = 'srihiw';
const CHANGE_NONCE = /^cc_[a-f0-9]{32}$/;
const ALIAS = '(Ppan|punpan_020)';

export function assertCreatorPolicyClient(clientId) {
  if (clientId !== CREATOR_POLICY_DEFAULTS.clientId) {
    throw new DomainError('CREATOR_POLICY_CLIENT_NOT_ALLOWED', 'Creator policy ยังรองรับเฉพาะ Ppan');
  }
  return clientId;
}

// The website policy bridge is scoped independently from Ppan-only LINE
// control, preview, and legacy test permit.
export function assertCreatorWebPolicyClient(clientId) {
  return clientId === SRIHIW_CREATOR_POLICY_CLIENT ? clientId : assertCreatorPolicyClient(clientId);
}

export function assertCreatorCapMinor(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DomainError('CREATOR_CAP_INVALID', 'เพดานต้องเป็นจำนวนเงินบาทมากกว่าศูนย์และทศนิยมไม่เกินสองตำแหน่ง');
  }
  return value;
}

export function creatorCapChangeNonce({ clientId, ownerLineUserId, sourceEventId }) {
  assertCreatorPolicyClient(clientId);
  if (typeof ownerLineUserId !== 'string' || !ownerLineUserId.trim() || ownerLineUserId.trim().length > 256
    || typeof sourceEventId !== 'string' || !sourceEventId.trim() || sourceEventId.trim().length > 256) {
    throw new DomainError('INVALID_REQUEST', 'ข้อมูลอ้างอิงคำขอเพดานไม่ถูกต้อง');
  }
  return `cc_${createHash('sha256').update(JSON.stringify([clientId, ownerLineUserId.trim(), sourceEventId.trim()])).digest('hex').slice(0, 32)}`;
}

export function parseCreatorCapAmount(value) {
  if (typeof value !== 'string') return null;
  const amount = value.normalize('NFKC');
  if (!/^(?:[1-9]\d*|0|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(amount)) return null;
  const [whole, fraction = ''] = amount.replaceAll(',', '').split('.');
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return minor > 0n && minor <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(minor) : null;
}

export function parseCreatorPolicyText(value) {
  if (typeof value !== 'string' || value.length > 250) return null;
  const text = value.normalize('NFKC').trim();
  const view = text.match(new RegExp(`^ดูเพดาน\\s+${ALIAS}$`, 'iu'));
  if (view) return { kind: 'creator_cap_view', clientAlias: view[1] };
  const propose = text.match(new RegExp(`^ตั้งเพดาน\\s+${ALIAS}\\s+(\\S+)$`, 'iu'));
  if (!propose) return null;
  const capMinor = parseCreatorCapAmount(propose[2]);
  return capMinor === null ? null : { kind: 'creator_cap_propose', clientAlias: propose[1], capMinor };
}

export function parseCreatorPolicyPostback(value) {
  if (typeof value !== 'string' || value.length > 200) return null;
  const params = new URLSearchParams(value);
  const keys = [...params.keys()];
  if (keys.length !== 2 || new Set(keys).size !== 2 || !keys.every(key => ['action', 'nonce'].includes(key))) return null;
  const action = params.get('action'), nonce = params.get('nonce');
  if (!CHANGE_NONCE.test(nonce ?? '')) return null;
  if (action === 'creator-cap-confirm') return { kind: 'creator_cap_confirm', nonce };
  if (action === 'creator-cap-cancel') return { kind: 'creator_cap_cancel', nonce };
  return null;
}

function formatMinor(value) {
  assertCreatorCapMinor(value);
  const minor = BigInt(value), whole = minor / 100n, cents = minor % 100n;
  return whole.toLocaleString('en-US') + (cents === 0n ? '' : `.${String(cents).padStart(2, '0')}`);
}

export function buildCreatorCapWebsiteOnlyMessage() {
  return {
    type: 'text',
    text: `การตั้งและยืนยันเพดาน Ppan ย้ายไปหน้า Automation แล้ว กรุณาเปลี่ยนผ่านเว็บไซต์: ${CREATOR_AUTOMATION_WEB_URL}\nLINE ดูเพดานปัจจุบันได้ด้วย “ดูเพดาน Ppan”`,
  };
}

export function buildCreatorPolicyStatusMessage(policy, { websiteOnly = false } = {}) {
  const cap = formatMinor(policy.capMinor ?? policy.campaignCapMinor);
  const mode = policy.mode === 'PAUSED' ? 'พัก Auto — เปลี่ยนเพดานแล้วก็ยังไม่เปิดเอง'
    : policy.executionEnabled === true ? 'Auto เปิดตามสิทธิ์ระบบ' : 'รอผ่านการทดสอบเขียนจริง — ยังไม่เพิ่มงบอัตโนมัติ';
  const location = websiteOnly ? 'เว็บไซต์' : 'LINE';
  const edit = websiteOnly ? CREATOR_AUTOMATION_WEB_URL : 'ตั้งเพดาน Ppan 10000';
  return {
    type: 'text',
    text: `เพดาน Creator Ppan: ${cap} บาท\nใช้เป็นเพดานต่อแคมเปญและรวมลูกค้าต่อวัน\nใช้ถึง 80% → เพิ่ม 20% จากงบปัจจุบัน\nสถานะ: ${mode}\nมีผลจนกว่าจะเปลี่ยนผ่าน ${location} (เวลาไทย)\nยังไม่ใช้ GMV/ROI จริงเพื่อตัดสินใจปิดหรือเปิดใหม่\nแก้ไข: ${edit}\nPolicy revision: ${policy.revision}`,
  };
}

export function buildCreatorCapProposalMessage(change) {
  const amount = formatMinor(change.capMinor);
  const expires = new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' }).format(new Date(change.expiresAt));
  return {
    type: 'flex',
    altText: `ยืนยันเพดาน Creator Ppan ${amount} บาท`,
    contents: {
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
        { type: 'text', text: 'ยืนยันเพดาน Creator Ppan', weight: 'bold', size: 'lg', wrap: true },
        { type: 'text', text: `${amount} บาท`, weight: 'bold', size: 'xl', wrap: true },
        { type: 'text', text: 'ใช้กับต่อแคมเปญและรวมลูกค้าต่อวัน\nการยืนยันนี้บันทึกกติกาเท่านั้น ไม่ปรับงบ TikTok และไม่เปิด Auto เอง', wrap: true, size: 'sm' },
        { type: 'text', text: 'หากลดเพดานต่ำกว่างบหรือยอดใช้ปัจจุบัน จะต้องระงับการเพิ่มงบต่อ ไม่ได้ย้อนยอดใช้ที่เกิดแล้ว', wrap: true, size: 'sm', color: '#805000' },
        { type: 'text', text: `ยืนยันก่อน ${expires} น. (เวลาไทย)`, wrap: true, size: 'xs', color: '#666666' },
      ] },
      footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
        { type: 'button', style: 'primary', action: { type: 'postback', label: 'ยืนยันเพดาน', data: `action=creator-cap-confirm&nonce=${change.nonce}`, displayText: `ยืนยันเพดาน Ppan ${amount} บาท` } },
        { type: 'button', action: { type: 'postback', label: 'ยกเลิก', data: `action=creator-cap-cancel&nonce=${change.nonce}`, displayText: 'ยกเลิกการเปลี่ยนเพดาน Ppan' } },
      ] },
    },
  };
}

export function buildCreatorCapResultMessage({ policy, status }) {
  const heading = status === 'CONFIRMED' ? '✅ บันทึกเพดานแล้ว — ยังไม่ได้ปรับงบ TikTok'
    : status === 'ALREADY_CONFIRMED' ? 'ℹ️ คำขอนี้ยืนยันไปแล้ว แสดงเพดานปัจจุบัน'
      : 'ยกเลิกคำขอเปลี่ยนเพดานแล้ว — เพดานเดิมยังคงอยู่';
  return { type: 'text', text: `${heading}\n\n${buildCreatorPolicyStatusMessage(policy).text}` };
}
