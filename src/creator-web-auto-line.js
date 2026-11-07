import { createHash } from 'node:crypto';
import { CREATOR_AUTOMATION_WEB_URL, CREATOR_POLICY_DEFAULTS, SRIHIW_CREATOR_POLICY_CLIENT } from './creator-policy.js';
import { formatMoney } from './line.js';
import { fromMinor } from './money.js';

// LINE keeps retry keys for 24 hours. Keep a margin for clocks and delivery.
export const CREATOR_AUTO_LINE_RETRY_WINDOW_MS = 23 * 60 * 60_000;
export const CREATOR_AUTO_LINE_CLAIM_MS = 45_000;
export const validCreatorLineRecipient = (value) => typeof value === 'string' && /^U[a-f0-9]{32}$/.test(value);

const budgetInteger = (value) => Number.isSafeInteger(value) && value > 0;
export function parseCreatorWebAutoBudget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 ||
      !Object.hasOwn(value, 'previousBudgetMinor') || !Object.hasOwn(value, 'targetBudgetMinor') ||
      !budgetInteger(value.previousBudgetMinor) || !budgetInteger(value.targetBudgetMinor)) return null;
  const expected = BigInt(value.previousBudgetMinor) * BigInt(10_000 + CREATOR_POLICY_DEFAULTS.increaseBps);
  if (BigInt(value.targetBudgetMinor) * 10_000n !== expected) return null;
  return { previousBudgetMinor: value.previousBudgetMinor, targetBudgetMinor: value.targetBudgetMinor };
}

export function isExplicitSrihiwSharedOwner(lineUserId, configuredHash) {
  return validCreatorLineRecipient(lineUserId) && typeof configuredHash === 'string' && /^[0-9a-f]{64}$/.test(configuredHash) &&
    createHash('sha256').update(lineUserId).digest('hex') === configuredHash;
}

export function creatorAutoLineMessage({ clientId, previousBudgetMinor, targetBudgetMinor }) {
  const name = clientId === SRIHIW_CREATOR_POLICY_CLIENT ? 'srihiw' : 'Ppan';
  const money = (minor) => formatMoney(fromMinor(minor, 'THB'), 'THB');
  return `✅ ${name} — เพิ่มงบอัตโนมัติสำเร็จ และอ่านผลกลับจาก TikTok แล้ว\nงบ ${money(previousBudgetMinor)} → ${money(targetBudgetMinor)}\nดูรายละเอียด: ${CREATOR_AUTOMATION_WEB_URL}`;
}

export function autoLineBackoffMs(attemptCount) {
  return Math.min(2 ** Math.min(Math.max(attemptCount - 1, 0), 6), 60) * 60_000;
}

export function retryableCreatorAutoLineError(error) {
  return error?.code === 'LINE_TRANSPORT_ERROR' || (Number.isInteger(error?.status) && error.status >= 500 && error.status <= 599);
}
