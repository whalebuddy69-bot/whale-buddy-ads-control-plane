function requiredId(value, name) {
  if (
    typeof value !== "string"
    || value.trim() !== value
    || !/^[1-9]\d{5,30}$/.test(value)
  ) {
    throw new Error(`${name} must be a TikTok numeric ID`);
  }
  return value;
}

function identityBindingMatches({ identity, store, businessCenterId }) {
  if (identity.identityType === "BC_AUTH_TT") {
    return identity.identityAuthorizedBcId === businessCenterId;
  }
  if (identity.identityType === "TTS_TT") {
    return identity.storeId === store.storeId;
  }
  return identity.identityType === "TT_USER";
}

function identityCandidate(identity) {
  return Object.freeze({
    identityId: identity.identityId,
    identityType: identity.identityType,
    identityAuthorizedBcId: identity.identityAuthorizedBcId ?? null,
    identityAuthorizedShopId: identity.identityAuthorizedShopId ?? null,
    storeId: identity.storeId ?? null,
    displayName: identity.displayName ?? null,
    userName: identity.userName ?? null,
    liveGmvMaxAvailable: identity.liveGmvMaxAvailable,
    unavailableReason: identity.unavailableReason ?? null,
    isRunningCustomShopAds: identity.isRunningCustomShopAds
  });
}

function campaignCandidate(row) {
  const campaignId = requiredId(row?.campaign_id, "campaign_id");
  const primaryStatus = typeof row?.primary_status === "string" && row.primary_status !== ""
    ? row.primary_status
    : null;
  return Object.freeze({
    campaignId,
    campaignName: typeof row?.campaign_name === "string" && row.campaign_name !== ""
      ? row.campaign_name
      : null,
    primaryStatus,
    requiresStatusReview: primaryStatus === null
  });
}

/**
 * First-run, read-only discovery gate.
 *
 * This function deliberately does not decide CREATE versus UPDATE. TikTok's
 * browser-visible account ID is not an API identity_id, and historical
 * campaign rows require status/schedule review. It returns only documented API
 * bindings that an operator must explicitly pin before a later preflight can
 * authorize even a dry-run write plan.
 */
export async function runLiveGmvMaxPreflight({
  tiktok,
  advertiserId,
  expectedTikTokAccountId,
  expectedBusinessCenterId,
  expectedCurrency,
  expectedTimezone
}) {
  if (!tiktok) throw new Error("TikTok client is required");
  const normalizedAdvertiserId = requiredId(advertiserId, "advertiserId");
  const normalizedTikTokAccountId = requiredId(
    expectedTikTokAccountId,
    "expectedTikTokAccountId"
  );
  const normalizedBusinessCenterId = requiredId(
    expectedBusinessCenterId,
    "expectedBusinessCenterId"
  );
  const normalizedCurrency = String(expectedCurrency ?? "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalizedCurrency)) {
    throw new Error("expectedCurrency must be a 3-letter ISO currency");
  }
  if (
    typeof expectedTimezone !== "string"
    || expectedTimezone === ""
    || expectedTimezone.trim() !== expectedTimezone
  ) {
    throw new Error("expectedTimezone is required");
  }

  const advertiser = await tiktok.getAdvertiserInfo({
    advertiserId: normalizedAdvertiserId
  });
  const accountMismatchReason = advertiser.currency !== normalizedCurrency
    ? "ADVERTISER_CURRENCY_MISMATCH"
    : advertiser.timezone !== expectedTimezone
      ? "ADVERTISER_TIMEZONE_MISMATCH"
      : advertiser.accountStatus !== "STATUS_ENABLE"
        ? "ADVERTISER_NOT_ENABLED"
        : null;
  if (accountMismatchReason) {
    return {
      decision: "BLOCKED",
      reason: accountMismatchReason,
      writeAuthorized: false,
      advertiserId: normalizedAdvertiserId,
      expectedTikTokAccountId: normalizedTikTokAccountId,
      expectedBusinessCenterId: normalizedBusinessCenterId,
      advertiser,
      requestIds: [advertiser.requestId]
    };
  }

  const storeResult = await tiktok.getGmvMaxStores({
    advertiserId: normalizedAdvertiserId
  });
  const eligibleStores = storeResult.stores.filter((store) => (
    store.isGmvMaxAvailable === true
    && store.storeAuthorizedBcId === normalizedBusinessCenterId
    && store.exclusiveAuthorizedAdvertiserInfo?.authorizationStatus === "EFFECTIVE"
    && store.exclusiveAuthorizedAdvertiserInfo?.advertiserId === normalizedAdvertiserId
  ));
  if (eligibleStores.length !== 1) {
    return {
      decision: "BLOCKED",
      reason: eligibleStores.length === 0
        ? "NO_EXCLUSIVELY_AUTHORIZED_STORE"
        : "MULTIPLE_EXCLUSIVELY_AUTHORIZED_STORES",
      writeAuthorized: false,
      advertiserId: normalizedAdvertiserId,
      expectedTikTokAccountId: normalizedTikTokAccountId,
      expectedBusinessCenterId: normalizedBusinessCenterId,
      advertiser,
      eligibleStoreCount: eligibleStores.length,
      storeCount: storeResult.stores.length,
      requestIds: [advertiser.requestId, storeResult.requestId]
    };
  }

  const [store] = eligibleStores;
  const identityResult = await tiktok.getGmvMaxIdentities({
    advertiserId: normalizedAdvertiserId,
    storeId: store.storeId,
    storeAuthorizedBcId: store.storeAuthorizedBcId
  });
  const exclusiveIdentityId = store.exclusiveAuthorizedAdvertiserInfo?.identityId ?? null;
  const identities = identityResult.identities
    .filter((identity) => (
      identityBindingMatches({
        identity,
        store,
        businessCenterId: normalizedBusinessCenterId
      })
      && (exclusiveIdentityId === null || identity.identityId === exclusiveIdentityId)
    ))
    .map(identityCandidate);
  if (identities.length === 0) {
    return {
      decision: "BLOCKED",
      reason: "NO_DOCUMENTED_API_IDENTITY_CANDIDATE",
      writeAuthorized: false,
      advertiserId: normalizedAdvertiserId,
      expectedTikTokAccountId: normalizedTikTokAccountId,
      expectedBusinessCenterId: normalizedBusinessCenterId,
      advertiser,
      storeId: store.storeId,
      storeAuthorizedBcId: store.storeAuthorizedBcId,
      requestIds: [
        advertiser.requestId,
        storeResult.requestId,
        identityResult.requestId
      ]
    };
  }

  let campaigns;
  try {
    campaigns = await tiktok.getLiveCampaigns({
      advertiserId: normalizedAdvertiserId,
      storeId: store.storeId,
      maxResults: 25
    });
  } catch (error) {
    if (error?.code !== "TIKTOK_CAMPAIGN_CANDIDATE_LIMIT") throw error;
    return {
      decision: "BLOCKED",
      reason: "TOO_MANY_LIVE_CAMPAIGN_CANDIDATES",
      writeAuthorized: false,
      advertiserId: normalizedAdvertiserId,
      expectedTikTokAccountId: normalizedTikTokAccountId,
      expectedBusinessCenterId: normalizedBusinessCenterId,
      advertiser,
      storeId: store.storeId,
      storeAuthorizedBcId: store.storeAuthorizedBcId,
      identityCandidates: identities,
      requestIds: [
        advertiser.requestId,
        storeResult.requestId,
        identityResult.requestId,
        error.requestId
      ].filter(Boolean)
    };
  }

  return {
    decision: "DISCOVERY_REQUIRED",
    reason: "PIN_EXACT_API_BINDING_BEFORE_WRITE_PLAN",
    writeAuthorized: false,
    advertiserId: normalizedAdvertiserId,
    expectedTikTokAccountId: normalizedTikTokAccountId,
    expectedBusinessCenterId: normalizedBusinessCenterId,
    advertiser,
    storeId: store.storeId,
    storeAuthorizedBcId: store.storeAuthorizedBcId,
    identityCandidates: identities,
    campaignCandidates: campaigns.map(campaignCandidate),
    requestIds: [
      advertiser.requestId,
      storeResult.requestId,
      identityResult.requestId
    ]
  };
}
