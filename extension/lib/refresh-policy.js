export const PAGE_REFRESH_INTERVALS_MINUTES = Object.freeze([2, 5, 10, 15, 30]);
export const DEFAULT_PAGE_REFRESH_INTERVAL_MINUTES = 2;
export const PAGE_REFRESH_USER_QUIET_MILLISECONDS = 5 * 60_000;
export const PAGE_RELOAD_TIMEOUT_MILLISECONDS = 30_000;

export function normalizePageRefreshSettings(value) {
  // The owner explicitly approved this fallback for the current pilot. An
  // existing 0.1 installation therefore becomes active after extension reload
  // without replacing its enrolled credential. A stored explicit `false`
  // remains authoritative and disables fallback once API reads are available.
  if (value === undefined || value === null) {
    return Object.freeze({ enabled: true, intervalMinutes: DEFAULT_PAGE_REFRESH_INTERVAL_MINUTES });
  }
  const requestedInterval = Number(value?.intervalMinutes);
  const intervalValid = PAGE_REFRESH_INTERVALS_MINUTES.includes(requestedInterval);
  return Object.freeze({
    // Corrupt or unsupported settings fail closed instead of silently enabling
    // a more aggressive reload cadence.
    enabled: value?.enabled === true && intervalValid,
    intervalMinutes: intervalValid
      ? requestedInterval
      : DEFAULT_PAGE_REFRESH_INTERVAL_MINUTES
  });
}

export function validatePageRefreshSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("page refresh settings must be an object");
  }
  if (typeof value.enabled !== "boolean") {
    throw new TypeError("page refresh enabled must be a boolean");
  }
  const intervalMinutes = Number(value.intervalMinutes);
  if (!PAGE_REFRESH_INTERVALS_MINUTES.includes(intervalMinutes)) {
    throw new TypeError("page refresh interval is not allowed");
  }
  return Object.freeze({ enabled: value.enabled, intervalMinutes });
}

export function pageRefreshDue({ settings, lastReloadAt, now = new Date() } = {}) {
  const normalized = normalizePageRefreshSettings(settings);
  if (!normalized.enabled) return false;
  const nowMilliseconds = new Date(now).getTime();
  if (!Number.isFinite(nowMilliseconds)) throw new TypeError("now must be a valid date");
  if (lastReloadAt == null || lastReloadAt === "") return true;
  const lastMilliseconds = Date.parse(lastReloadAt);
  if (!Number.isFinite(lastMilliseconds) || lastMilliseconds > nowMilliseconds) return false;
  return nowMilliseconds - lastMilliseconds >= normalized.intervalMinutes * 60_000;
}
