import { createHash } from 'node:crypto';
import {
  ASHOPBYTHETA_CREATOR_POLICY_CLIENT, assertCreatorWebPolicyClient, BUBPA_SHOP189_CREATOR_POLICY_CLIENT,
  CREATOR_AUTOMATION_WEB_URL, CREATOR_POLICY_DEFAULTS, KOOLKOOL888_CREATOR_POLICY_CLIENT, MYUSHOP4_CREATOR_POLICY_CLIENT,
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
  [KOOLKOOL888_CREATOR_POLICY_CLIENT]: '@koolkool888',
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

const CHECK_FAILURE_INCIDENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const validCreatorCheckFailureIncidentId = (value) => typeof value === 'string' && CHECK_FAILURE_INCIDENT_ID.test(value);

export function parseCreatorCheckFailureAlert(input, clientId) {
  const expected = ['incidentId', 'advertiserName', 'tiktokUsername', 'failedChecks'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== expected.length ||
      !expected.every(field => Object.hasOwn(input, field)) || !validCreatorCheckFailureIncidentId(input.incidentId) ||
      typeof input.advertiserName !== 'string' || input.advertiserName.length < 1 || input.advertiserName.length > 120 ||
      input.advertiserName.trim() !== input.advertiserName || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(input.advertiserName) ||
      input.failedChecks !== 10 || typeof input.tiktokUsername !== 'string' ||
      `@${input.tiktokUsername}` !== VERIFIED_LINE_HANDLES[clientId]) return null;
  return { incidentId: input.incidentId, advertiserName: input.advertiserName, tiktokUsername: input.tiktokUsername, failedChecks: 10 };
}

export function creatorCheckFailureLineMessage({ clientId, advertiserName }) {
  return `⚠️ Auto Budget Increase ตรวจไม่สำเร็จ 10 รอบติดกัน (ตรวจประมาณทุก 1 นาที)\nบัญชีโฆษณา: ${advertiserName}\nTikTok: ${creatorAutomationLineLabel(clientId)}\nตรวจสถานะบนเว็บ: ${CREATOR_AUTOMATION_WEB_URL}`;
}

export function creatorCheckFailureRetryKey(clientId, incidentId) {
  const bytes = createHash('sha256').update(JSON.stringify(['creator-check-failure-v1', clientId, incidentId])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function autoLineBackoffMs(attemptCount) {
  return Math.min(2 ** Math.min(Math.max(attemptCount - 1, 0), 6), 60) * 60_000;
}

export function retryableCreatorAutoLineError(error) {
  return error?.code === 'LINE_TRANSPORT_ERROR' || (Number.isInteger(error?.status) && error.status >= 500 && error.status <= 599);
}
