import { randomUUID } from 'node:crypto';

export const RequestState = Object.freeze({
  PENDING_INPUT: 'PENDING_INPUT',
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  EXECUTING: 'EXECUTING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
});

const REQUEST_STATES = new Set(Object.values(RequestState));
const TERMINAL_STATES = new Set([
  RequestState.SUCCEEDED,
  RequestState.FAILED,
  RequestState.EXPIRED,
  RequestState.CANCELLED,
]);

export const ALLOWED_TRANSITIONS = Object.freeze({
  [RequestState.PENDING_INPUT]: Object.freeze([
    RequestState.PENDING_APPROVAL,
    RequestState.EXPIRED,
    RequestState.CANCELLED,
  ]),
  [RequestState.PENDING_APPROVAL]: Object.freeze([
    RequestState.EXECUTING,
    RequestState.EXPIRED,
    RequestState.CANCELLED,
  ]),
  [RequestState.EXECUTING]: Object.freeze([
    RequestState.SUCCEEDED,
    RequestState.FAILED,
  ]),
  [RequestState.SUCCEEDED]: Object.freeze([]),
  [RequestState.FAILED]: Object.freeze([]),
  [RequestState.EXPIRED]: Object.freeze([]),
  [RequestState.CANCELLED]: Object.freeze([]),
});

export class DomainError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, details) {
  throw new DomainError(code, message, details);
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail('INVALID_REQUEST', `${field} must be a non-empty string`, { field });
  }
  return value.trim();
}

function optionalString(value, field) {
  if (value === undefined || value === null) return null;
  return requiredString(value, field);
}

function money(value, field, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < 0 || (positive && value === 0)) {
    fail(
      positive ? 'INVALID_INCREASE' : 'INVALID_REQUEST',
      `${field} must be a ${positive ? 'positive ' : 'non-negative '}safe integer in minor currency units`,
      { field, value },
    );
  }
  return value;
}

function isoTime(value, field) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    fail('INVALID_REQUEST', `${field} must be a valid date`, { field, value });
  }
  return parsed.toISOString();
}

function nowIso(value) {
  return isoTime(value ?? new Date(), 'now');
}

function cloneJson(value, field = 'metadata') {
  if (value === undefined) return {};
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError('not JSON serializable');
    return JSON.parse(encoded);
  } catch (error) {
    fail('INVALID_REQUEST', `${field} must be JSON serializable`, {
      field,
      reason: error.message,
    });
  }
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function authorizedUsers(input) {
  const supplied = input.authorizedLineUserIds ??
    (input.authorizedLineUserId === undefined ? undefined : [input.authorizedLineUserId]);
  if (!Array.isArray(supplied) || supplied.length === 0) {
    fail('INVALID_REQUEST', 'authorizedLineUserIds must contain at least one LINE user id', {
      field: 'authorizedLineUserIds',
    });
  }
  return [...new Set(supplied.map((value) => requiredString(value, 'authorizedLineUserIds[]')))].sort();
}

function assertState(request, expected) {
  const expectedStates = Array.isArray(expected) ? expected : [expected];
  if (!expectedStates.includes(request.state)) {
    fail('INVALID_STATE', `Request in ${request.state} cannot perform this operation`, {
      state: request.state,
      expectedStates,
    });
  }
}

function assertAuthorized(request, actorLineUserId) {
  const actor = requiredString(actorLineUserId, 'actorLineUserId');
  if (!request.authorizedLineUserIds.includes(actor)) {
    fail('UNAUTHORIZED_USER', 'LINE user is not authorized for this budget request', {
      actorLineUserId: actor,
      requestId: request.id,
    });
  }
  return actor;
}

function assertNotExpired(request, at) {
  if (Date.parse(at) >= Date.parse(request.expiresAt)) {
    fail('REQUEST_EXPIRED', 'Budget request has expired', {
      requestId: request.id,
      expiresAt: request.expiresAt,
      now: at,
    });
  }
}

function nextVersion(request, state, at, patch = {}) {
  if (!ALLOWED_TRANSITIONS[request.state].includes(state)) {
    fail('INVALID_STATE', `Transition ${request.state} -> ${state} is not allowed`, {
      from: request.state,
      to: state,
    });
  }
  return hydrateBudgetRequest({
    ...request,
    ...patch,
    state,
    updatedAt: at,
    version: request.version + 1,
  });
}

/**
 * Creates a request around an exact TikTok budget snapshot. All money values use
 * minor units (satang for THB), avoiding floating-point changes to ad budgets.
 */
export function createBudgetRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('INVALID_REQUEST', 'Budget request input must be an object');
  }

  const createdAt = nowIso(input.createdAt);
  const expiresAt = input.expiresAt === undefined
    ? new Date(Date.parse(createdAt) + 15 * 60_000).toISOString()
    : isoTime(input.expiresAt, 'expiresAt');
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
    fail('INVALID_REQUEST', 'expiresAt must be later than createdAt', {
      createdAt,
      expiresAt,
    });
  }

  const currentBudgetMinor = money(input.currentBudgetMinor, 'currentBudgetMinor');
  const maxBudgetMinor = money(input.maxBudgetMinor, 'maxBudgetMinor', { positive: true });
  const maxIncreaseMinor = money(input.maxIncreaseMinor, 'maxIncreaseMinor', { positive: true });
  if (maxBudgetMinor <= currentBudgetMinor) {
    fail('INVALID_REQUEST', 'maxBudgetMinor must be greater than currentBudgetMinor', {
      currentBudgetMinor,
      maxBudgetMinor,
    });
  }

  return hydrateBudgetRequest({
    schemaVersion: 1,
    id: input.id ?? randomUUID(),
    agencyId: input.agencyId,
    clientId: input.clientId,
    adAccountId: input.adAccountId,
    campaignId: input.campaignId,
    state: RequestState.PENDING_INPUT,
    authorizedLineUserIds: authorizedUsers(input),
    currency: input.currency ?? 'THB',
    currentBudgetMinor,
    increaseMinor: null,
    targetBudgetMinor: null,
    guardrails: {
      maxBudgetMinor,
      maxIncreaseMinor,
    },
    amountSubmission: null,
    execution: null,
    result: null,
    failure: null,
    cancellation: null,
    createdAt,
    updatedAt: createdAt,
    expiresAt,
    version: 0,
    metadata: cloneJson(input.metadata),
  });
}

/** Validate amount, authorization, expiry, ceiling, and maximum permitted delta. */
export function validateBudgetAmount(request, { actorLineUserId, increaseMinor, now } = {}) {
  assertBudgetRequest(request);
  assertState(request, RequestState.PENDING_INPUT);
  const at = nowIso(now);
  const actor = assertAuthorized(request, actorLineUserId);
  assertNotExpired(request, at);
  const increase = money(increaseMinor, 'increaseMinor', { positive: true });
  if (increase > request.guardrails.maxIncreaseMinor) {
    fail('MAX_DELTA_EXCEEDED', 'Requested budget increase exceeds the permitted delta', {
      increaseMinor: increase,
      maxIncreaseMinor: request.guardrails.maxIncreaseMinor,
    });
  }
  const target = request.currentBudgetMinor + increase;
  if (!Number.isSafeInteger(target)) {
    fail('BUDGET_CEILING_EXCEEDED', 'Target budget is outside the safe integer range');
  }
  if (target > request.guardrails.maxBudgetMinor) {
    fail('BUDGET_CEILING_EXCEEDED', 'Target budget exceeds the configured ceiling', {
      targetBudgetMinor: target,
      maxBudgetMinor: request.guardrails.maxBudgetMinor,
    });
  }
  return Object.freeze({ actorLineUserId: actor, increaseMinor: increase, targetBudgetMinor: target, now: at });
}

export function submitBudgetAmount(request, input) {
  const validated = validateBudgetAmount(request, input);
  return nextVersion(request, RequestState.PENDING_APPROVAL, validated.now, {
    increaseMinor: validated.increaseMinor,
    targetBudgetMinor: validated.targetBudgetMinor,
    amountSubmission: {
      actorLineUserId: validated.actorLineUserId,
      submittedAt: validated.now,
    },
  });
}

/**
 * Re-runs every guardrail immediately before execution. In particular, the live
 * platform budget must still equal the snapshot used to calculate the target.
 */
export function validateBudgetExecution(
  request,
  { actorLineUserId, observedCurrentBudgetMinor, now } = {},
) {
  assertBudgetRequest(request);
  assertState(request, RequestState.PENDING_APPROVAL);
  const at = nowIso(now);
  const actor = assertAuthorized(request, actorLineUserId);
  assertNotExpired(request, at);
  money(request.increaseMinor, 'increaseMinor', { positive: true });

  if (request.increaseMinor > request.guardrails.maxIncreaseMinor) {
    fail('MAX_DELTA_EXCEEDED', 'Requested budget increase exceeds the permitted delta');
  }
  if (request.targetBudgetMinor > request.guardrails.maxBudgetMinor) {
    fail('BUDGET_CEILING_EXCEEDED', 'Target budget exceeds the configured ceiling');
  }

  const observed = money(observedCurrentBudgetMinor, 'observedCurrentBudgetMinor');
  if (observed !== request.currentBudgetMinor) {
    fail('STALE_CURRENT_BUDGET', 'TikTok budget changed after this request was created', {
      expectedCurrentBudgetMinor: request.currentBudgetMinor,
      observedCurrentBudgetMinor: observed,
    });
  }

  return Object.freeze({ actorLineUserId: actor, observedCurrentBudgetMinor: observed, now: at });
}

export function beginBudgetExecution(request, input = {}) {
  const validated = validateBudgetExecution(request, input);
  const executionId = input.executionId === undefined
    ? randomUUID()
    : requiredString(input.executionId, 'executionId');
  return nextVersion(request, RequestState.EXECUTING, validated.now, {
    execution: {
      id: executionId,
      approvedByLineUserId: validated.actorLineUserId,
      startedAt: validated.now,
      observedCurrentBudgetMinor: validated.observedCurrentBudgetMinor,
      attempt: 1,
    },
  });
}

export function succeedBudgetRequest(
  request,
  { actualBudgetMinor, platformReference = null, now } = {},
) {
  assertBudgetRequest(request);
  assertState(request, RequestState.EXECUTING);
  const at = nowIso(now);
  const actual = money(actualBudgetMinor, 'actualBudgetMinor');
  if (actual !== request.targetBudgetMinor) {
    fail('UNEXPECTED_PLATFORM_BUDGET', 'Platform result does not match the approved target budget', {
      targetBudgetMinor: request.targetBudgetMinor,
      actualBudgetMinor: actual,
    });
  }
  return nextVersion(request, RequestState.SUCCEEDED, at, {
    result: {
      actualBudgetMinor: actual,
      platformReference: optionalString(platformReference, 'platformReference'),
      completedAt: at,
    },
  });
}

export function failBudgetRequest(request, { code, message, retryable = false, now } = {}) {
  assertBudgetRequest(request);
  assertState(request, RequestState.EXECUTING);
  const at = nowIso(now);
  return nextVersion(request, RequestState.FAILED, at, {
    failure: {
      code: requiredString(code, 'code'),
      message: requiredString(message, 'message'),
      retryable: Boolean(retryable),
      failedAt: at,
    },
  });
}

export function expireBudgetRequest(request, { now } = {}) {
  assertBudgetRequest(request);
  assertState(request, [RequestState.PENDING_INPUT, RequestState.PENDING_APPROVAL]);
  const at = nowIso(now);
  if (Date.parse(at) < Date.parse(request.expiresAt)) {
    fail('REQUEST_NOT_EXPIRED', 'Cannot expire a request before its expiration time', {
      expiresAt: request.expiresAt,
      now: at,
    });
  }
  return nextVersion(request, RequestState.EXPIRED, at);
}

export function cancelBudgetRequest(request, { actorLineUserId, reason = 'Cancelled by operator', now } = {}) {
  assertBudgetRequest(request);
  assertState(request, [RequestState.PENDING_INPUT, RequestState.PENDING_APPROVAL]);
  const at = nowIso(now);
  const actor = assertAuthorized(request, actorLineUserId);
  return nextVersion(request, RequestState.CANCELLED, at, {
    cancellation: {
      actorLineUserId: actor,
      reason: requiredString(reason, 'reason'),
      cancelledAt: at,
    },
  });
}

export function isTerminalState(state) {
  return TERMINAL_STATES.has(state);
}

/** Validate persisted/untrusted JSON and return it as an immutable value object. */
export function hydrateBudgetRequest(value) {
  const copy = cloneJson(value, 'budgetRequest');
  assertBudgetRequest(copy);
  return deepFreeze(copy);
}

export function assertBudgetRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    fail('INVALID_REQUEST', 'Budget request must be an object');
  }
  if (request.schemaVersion !== 1) fail('INVALID_REQUEST', 'Unsupported budget request schemaVersion');
  for (const field of ['id', 'agencyId', 'clientId', 'adAccountId', 'campaignId']) {
    requiredString(request[field], field);
  }
  if (!REQUEST_STATES.has(request.state)) fail('INVALID_REQUEST', 'Unknown request state', { state: request.state });
  if (!Array.isArray(request.authorizedLineUserIds) || request.authorizedLineUserIds.length === 0) {
    fail('INVALID_REQUEST', 'authorizedLineUserIds must not be empty');
  }
  request.authorizedLineUserIds.forEach((id) => requiredString(id, 'authorizedLineUserIds[]'));
  const currency = requiredString(request.currency, 'currency');
  if (!/^[A-Z]{3}$/.test(currency)) fail('INVALID_REQUEST', 'currency must be a 3-letter uppercase ISO code');
  money(request.currentBudgetMinor, 'currentBudgetMinor');
  if (!request.guardrails || typeof request.guardrails !== 'object') fail('INVALID_REQUEST', 'guardrails are required');
  money(request.guardrails.maxBudgetMinor, 'guardrails.maxBudgetMinor', { positive: true });
  money(request.guardrails.maxIncreaseMinor, 'guardrails.maxIncreaseMinor', { positive: true });
  if (request.guardrails.maxBudgetMinor <= request.currentBudgetMinor) {
    fail('INVALID_REQUEST', 'Budget ceiling must be greater than the current budget snapshot');
  }
  const createdAt = isoTime(request.createdAt, 'createdAt');
  const updatedAt = isoTime(request.updatedAt, 'updatedAt');
  const expiresAt = isoTime(request.expiresAt, 'expiresAt');
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
    fail('INVALID_REQUEST', 'expiresAt must be later than createdAt');
  }
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    fail('INVALID_REQUEST', 'updatedAt cannot be earlier than createdAt');
  }
  if (!Number.isSafeInteger(request.version) || request.version < 0) fail('INVALID_REQUEST', 'version must be a non-negative safe integer');

  const hasAmount = request.increaseMinor !== null || request.targetBudgetMinor !== null;
  if (hasAmount) {
    money(request.increaseMinor, 'increaseMinor', { positive: true });
    money(request.targetBudgetMinor, 'targetBudgetMinor', { positive: true });
    if (request.currentBudgetMinor + request.increaseMinor !== request.targetBudgetMinor) {
      fail('INVALID_REQUEST', 'targetBudgetMinor must equal currentBudgetMinor + increaseMinor');
    }
    if (request.increaseMinor > request.guardrails.maxIncreaseMinor) {
      fail('INVALID_REQUEST', 'increaseMinor exceeds the persisted maximum delta');
    }
    if (request.targetBudgetMinor > request.guardrails.maxBudgetMinor) {
      fail('INVALID_REQUEST', 'targetBudgetMinor exceeds the persisted budget ceiling');
    }
  }
  if (request.state === RequestState.PENDING_INPUT && hasAmount) {
    fail('INVALID_REQUEST', 'PENDING_INPUT request cannot contain an amount');
  }
  if ([RequestState.PENDING_APPROVAL, RequestState.EXECUTING, RequestState.SUCCEEDED, RequestState.FAILED].includes(request.state) && !hasAmount) {
    fail('INVALID_REQUEST', `${request.state} request must contain an approved amount`);
  }
  if ([RequestState.PENDING_APPROVAL, RequestState.EXECUTING, RequestState.SUCCEEDED, RequestState.FAILED].includes(request.state) && !request.amountSubmission) {
    fail('INVALID_REQUEST', `${request.state} request must contain amount submission details`);
  }
  if ([RequestState.EXECUTING, RequestState.SUCCEEDED, RequestState.FAILED].includes(request.state) && !request.execution) {
    fail('INVALID_REQUEST', `${request.state} request must contain execution details`);
  }
  if (request.state === RequestState.SUCCEEDED && !request.result) fail('INVALID_REQUEST', 'SUCCEEDED request must contain a result');
  if (request.state === RequestState.FAILED && !request.failure) fail('INVALID_REQUEST', 'FAILED request must contain failure details');
  if (request.state === RequestState.CANCELLED && !request.cancellation) fail('INVALID_REQUEST', 'CANCELLED request must contain cancellation details');
  cloneJson(request.metadata, 'metadata');
  return true;
}
