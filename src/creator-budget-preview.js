import { createHash } from 'node:crypto';
import { CREATOR_POLICY_DEFAULTS } from './creator-policy.js';
import { CREATOR_BINDING } from './creator-read.js';

const { clientId, timezone, thresholdBps, increaseBps } = CREATOR_POLICY_DEFAULTS;
const MAX_AGE_MS = 180_000;
const MAX_FUTURE_MS = 30_000;
const BASIS_POINTS = 10_000n;
const MAX_SAFE_MINOR = BigInt(Number.MAX_SAFE_INTEGER);
const bangkokDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
});
const positiveMinor = value => Number.isSafeInteger(value) && value > 0;
const nonnegativeMinor = value => Number.isSafeInteger(value) && value >= 0;
const campaignIdValid = value => typeof value === 'string' && /^[1-9]\d{5,30}$/.test(value);
const decision = (reason, fields = {}) => Object.freeze({
  dryRun: true, eligible: reason === 'ELIGIBLE', reason, ...fields,
});

// Pure projection: even an eligible result is not permission to send a TikTok
// mutation. The read adapter verifies the full Creator identity, no-Shop LIVE
// campaign, and uniqueness before yielding the normalized snapshot below.
export function evaluateCreatorBudgetPreview({ snapshot, policy, identity, now } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(nowMs) || !Number.isFinite(new Date(nowMs).getTime())) return decision('CLOCK_INVALID');
  if (!snapshot || snapshot.unavailable !== false) return decision('SNAPSHOT_UNAVAILABLE');
  if (identity?.clientId !== clientId || identity.advertiserId !== CREATOR_BINDING.advertiserId
    || identity.tiktokAccountId !== CREATOR_BINDING.tiktokAccountId
    || snapshot.clientId !== identity.clientId || snapshot.advertiserId !== identity.advertiserId
    || snapshot.tiktokAccountId !== identity.tiktokAccountId
    || snapshot.source !== 'tiktok-creator-api' || snapshot.readOnly !== true
    || snapshot.timezone !== timezone) return decision('IDENTITY_MISMATCH');

  const observed = typeof snapshot.observedAt === 'string' ? Date.parse(snapshot.observedAt) : NaN;
  const age = nowMs - observed;
  if (!Number.isFinite(age) || age < -MAX_FUTURE_MS || age > MAX_AGE_MS) return decision('STALE_SNAPSHOT');
  const reportingDate = bangkokDate.format(nowMs);
  if (snapshot.reportingDate !== reportingDate || bangkokDate.format(observed) !== reportingDate) {
    return decision('REPORTING_DAY_MISMATCH');
  }
  if (!policy) return decision('POLICY_UNAVAILABLE');
  if (policy.clientId !== clientId || policy.timezone !== timezone || policy.executionEnabled !== false
    || !Number.isSafeInteger(policy.revision) || policy.revision < 1
    || policy.thresholdBps !== thresholdBps || policy.increaseBps !== increaseBps
    || !positiveMinor(policy.campaignCapMinor) || !positiveMinor(policy.clientDailyCapMinor)) return decision('POLICY_UNVERIFIED');
  if (policy.mode === 'PAUSED') return decision('POLICY_PAUSED');
  if (policy.mode !== 'AUTO_PENDING_TEST') return decision('POLICY_UNVERIFIED');
  if (snapshot.noActiveCampaign === true) return decision('NO_ACTIVE_CAMPAIGN');
  const { campaignId, currency, dailyBudgetMinor: currentBudgetMinor, costMinor: spendMinor,
    nativeAutoBudgetState, aggregateSpendMinor } = snapshot;
  if (snapshot.noActiveCampaign !== false || !campaignIdValid(campaignId) || currency !== 'THB'
    || snapshot.campaignStatus !== 'ACTIVE' || snapshot.campaignOperationStatus !== 'ENABLE') return decision('CAMPAIGN_UNVERIFIED');
  if (identity.campaignId != null && identity.campaignId !== campaignId) return decision('IDENTITY_MISMATCH');
  if (!positiveMinor(currentBudgetMinor) || !nonnegativeMinor(spendMinor)) return decision('BUDGET_OR_SPEND_UNVERIFIED');
  if (snapshot.aggregateSpendComplete !== true || !nonnegativeMinor(aggregateSpendMinor)
    || aggregateSpendMinor < spendMinor) return decision('AGGREGATE_SPEND_UNVERIFIED');

  const { campaignCapMinor, clientDailyCapMinor, revision: policyRevision } = policy;
  const thresholdMinor = Number((BigInt(currentBudgetMinor) * BigInt(thresholdBps) + BASIS_POINTS - 1n) / BASIS_POINTS);
  const otherSpendMinor = aggregateSpendMinor - spendMinor;
  const campaignName = typeof snapshot.campaignName === 'string'
    ? snapshot.campaignName.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200) : null;
  const baseline = {
    clientId, campaignId, campaignName, reportingDate, observedAt: new Date(observed).toISOString(), currency,
    currentBudgetMinor, thresholdMinor, spendMinor, aggregateSpendMinor, otherSpendMinor,
    campaignCapMinor, clientDailyCapMinor, thresholdBps, increaseBps, policyRevision,
    nativeAutoBudgetState: ['DISABLED', 'UNKNOWN', 'ENABLED', 'CONFLICT'].includes(nativeAutoBudgetState)
      ? nativeAutoBudgetState : null,
  };
  // UNKNOWN is acceptable only for a labelled simulation; it does not clear a real writer.
  if (!['DISABLED', 'UNKNOWN'].includes(nativeAutoBudgetState)) return decision('NATIVE_AUTO_BUDGET_CONFLICT', baseline);
  if (spendMinor < thresholdMinor) return decision('BELOW_THRESHOLD', baseline);

  const scaled = BigInt(currentBudgetMinor) * (BASIS_POINTS + BigInt(increaseBps));
  const proposal = scaled / BASIS_POINTS;
  const projected = BigInt(otherSpendMinor) + proposal;
  if (scaled % BASIS_POINTS !== 0n || proposal > MAX_SAFE_MINOR || projected > MAX_SAFE_MINOR) {
    return decision('PROPOSAL_UNREPRESENTABLE', baseline);
  }
  const proposalFields = { ...baseline, proposedBudgetMinor: Number(proposal), projectedClientSpendMinor: Number(projected) };
  if (proposal > BigInt(campaignCapMinor)) return decision('CAMPAIGN_CAP_EXCEEDED', proposalFields);
  if (projected > BigInt(clientDailyCapMinor) || aggregateSpendMinor > clientDailyCapMinor) {
    return decision('CLIENT_DAILY_CAP_EXCEEDED', proposalFields);
  }
  const key = `cbp_${createHash('sha256').update(JSON.stringify([
    clientId, identity.advertiserId, identity.tiktokAccountId, campaignId, reportingDate, currentBudgetMinor,
  ])).digest('hex')}`;
  return decision('ELIGIBLE', { ...proposalFields, key });
}
