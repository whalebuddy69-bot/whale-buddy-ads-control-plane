import { createHash } from 'node:crypto';
import {
  ASHOPBYTHETA_CREATOR_POLICY_CLIENT, assertCreatorWebPolicyClient, BUBPA_SHOP189_CREATOR_POLICY_CLIENT,
  CREATOR_AUTOMATION_WEB_URL, CREATOR_POLICY_DEFAULTS, MYUSHOP4_CREATOR_POLICY_CLIENT,
  NNSHOP5719_CREATOR_POLICY_CLIENT, SRIHIW_CREATOR_POLICY_CLIENT,
} from './creator-policy.js';
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

// Display-only labels from TikTok identity/info for the explicitly configured,
// verified bindings. Never turn an arbitrary client ID into a TikTok handle.
const VERIFIED_LINE_HANDLES = Object.freeze({
  [CREATOR_POLICY_DEFAULTS.clientId]: '@punpanshop888',
  [SRIHIW_CREATOR_POLICY_CLIENT]: '@srihiw',
  [NNSHOP5719_CREATOR_POLICY_CLIENT]: '@nnshop5719',
  [ASHOPBYTHETA_CREATOR_POLICY_CLIENT]: '@ashopbytheta',
  [MYUSHOP4_CREATOR_POLICY_CLIENT]: '@myushop4',
  [BUBPA_SHOP189_CREATOR_POLICY_CLIENT]: '@bubpa_shop189',
});

export function creatorAutomationLineLabel(clientId) {
  assertCreatorWebPolicyClient(clientId);
  return VERIFIED_LINE_HANDLES[clientId] ?? clientId;
}

export function creatorAutoLineMessage({ clientId, previousBudgetMinor, targetBudgetMinor }) {
  const name = creatorAutomationLineLabel(clientId);
  const money = (minor) => formatMoney(fromMinor(minor, 'THB'), 'THB');
  return `✅ ${name} — เพิ่มงบอัตโนมัติสำเร็จ และอ่านผลกลับจาก TikTok แล้ว\nงบ ${money(previousBudgetMinor)} → ${money(targetBudgetMinor)}\nดูรายละเอียด: ${CREATOR_AUTOMATION_WEB_URL}`;
}

export function autoLineBackoffMs(attemptCount) {
  return Math.min(2 ** Math.min(Math.max(attemptCount - 1, 0), 6), 60) * 60_000;
}

export function retryableCreatorAutoLineError(error) {
  return error?.code === 'LINE_TRANSPORT_ERROR' || (Number.isInteger(error?.status) && error.status >= 500 && error.status <= 599);
}
