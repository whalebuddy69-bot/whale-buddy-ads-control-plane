export const CONTROL_PLANE_ORIGIN = "https://whale-buddy-ads-control-plane.onrender.com";

export const ENDPOINTS = Object.freeze({
  enroll: "/telemetry/chrome/enroll",
  snapshots: "/telemetry/chrome/snapshots"
});

export const PILOT_BINDING = Object.freeze({
  clientId: "punpan_020",
  advertiserId: "7646832328389263378",
  businessCenterId: "7627179356976201745",
  expectedTikTokAccountId: "7285935731820920833",
  browserProfile: "Whalebuddy Ads",
  tabGroup: "Ppan",
  sellerMode: "withoutShop",
  pageType: "live",
  currency: "THB",
  timezone: "Asia/Bangkok",
  liveWindow: Object.freeze({ start: "06:00", end: "23:00" })
});

// These must match telemetry v2 in src/telemetry.js. The fingerprint covers
// the approved semantic mapping, not the literal DOM headers.
export const TELEMETRY_SCHEMA_VERSION = 2;
export const UI_SCHEMA_FINGERPRINT =
  "e1163e229b1c451871300ad6c06309d776b44c4269b6f2c939d4b2aac9e5c5fc";

export const STORAGE_KEYS = Object.freeze({
  installationId: "installationId",
  credential: "telemetryCredential",
  status: "collectorStatus",
  lease: "collectorLease",
  pageRefreshSettings: "pageRefreshSettings"
});

export const ALARM_NAME = "wb-live-gmv-check";
export const KEY_RECORD_ID = "telemetry-p256-v1";

export const MESSAGE_TYPES = Object.freeze({
  collect: "WB_COLLECT_TIKTOK_LIVE",
  enroll: "WB_ENROLL_TELEMETRY",
  checkNow: "WB_CHECK_NOW",
  getStatus: "WB_GET_STATUS",
  updatePageRefreshSettings: "WB_UPDATE_PAGE_REFRESH_SETTINGS",
  refreshIfSafe: "WB_REFRESH_TIKTOK_IF_SAFE"
});

export const DASHBOARD = Object.freeze({
  origin: "https://ads.tiktok.com",
  pathname: "/i18n/gmv-max/dashboard"
});
