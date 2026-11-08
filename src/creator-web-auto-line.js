import { createHash } from 'node:crypto';
import { assertCreatorWebPolicyClient, CREATOR_AUTOMATION_WEB_URL, CREATOR_POLICY_DEFAULTS } from './creator-policy.js';
import { formatMoney } from './line.js';
import { fromMinor } from './money.js';

// LINE keeps retry keys for 24 hours. Keep a margin for clocks and delivery.
export const CREATOR_AUTO_LINE_RETRY_WINDOW_MS = 23 * 60 * 60_000;
export const CREATOR_AUTO_LINE_CLAIM_MS = 45_000;
export const validCreatorLineRecipient = (value) => typeof value === 'string' && /^U[a-f0-9]{32}$/.test(value);

const budgetInteger = (value) => Number.isSafeInteger(value) && value > 0;
export function parseCreatorWebAutoBudget(value, clientId) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !Object.hasOwn(value, 'previousBudgetMinor') || !Object.hasOwn(value, 'targetBudgetMinor') ||
      !budgetInteger(value.previousBudgetMinor) || !budgetInteger(value.targetBudgetMinor) ||
      value.targetBudgetMinor <= value.previousBudgetMinor) return null;
  const floor = Object.hasOwn(value, 'rounding');
  if (Object.keys(value).length !== (floor ? 3 : 2) || (floor &&
      (clientId !== CREATOR_POLICY_DEFAULTS.clientId || value.rounding !== 'floor-satang'))) return null;
  const expected = BigInt(value.previousBudgetMinor) * BigInt(10_000 + CREATOR_POLICY_DEFAULTS.increaseBps);
  const target = BigInt(value.targetBudgetMinor);
  if (floor ? target !== expected / 10_000n : target * 10_000n !== expected) return null;
  return { previousBudgetMinor: value.previousBudgetMinor, targetBudgetMinor: value.targetBudgetMinor,
    ...(floor ? { rounding: 'floor-satang' } : {}) };
}

export function isExplicitCreatorSharedOwner(lineUserId, configuredHash) {
  return validCreatorLineRecipient(lineUserId) && typeof configuredHash === 'string' && /^[0-9a-f]{64}$/.test(configuredHash) &&
    createHash('sha256').update(lineUserId).digest('hex') === configuredHash;
}

export function creatorAutoLineMessage({ clientId, previousBudgetMinor, targetBudgetMinor }) {
  assertCreatorWebPolicyClient(clientId);
  const name = clientId === CREATOR_POLICY_DEFAULTS.clientId ? 'Ppan' : clientId;
  const money = (minor) => formatMoney(fromMinor(minor, 'THB'), 'THB');
  return `✅ ${name} — เพิ่มงบอัตโนมัติสำเร็จ และอ่านผลกลับจาก TikTok แล้ว\nงบ ${money(previousBudgetMinor)} → ${money(targetBudgetMinor)}\nดูรายละเอียด: ${CREATOR_AUTOMATION_WEB_URL}`;
}

export function autoLineBackoffMs(attemptCount) {
  return Math.min(2 ** Math.min(Math.max(attemptCount - 1, 0), 6), 60) * 60_000;
}

export function retryableCreatorAutoLineError(error) {
  return error?.code === 'LINE_TRANSPORT_ERROR' || (Number.isInteger(error?.status) && error.status >= 500 && error.status <= 599);
}
