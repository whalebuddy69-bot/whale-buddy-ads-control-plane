export const AUTO_BOOST_TIME_ZONE = "Asia/Bangkok";

const MINUTES_PER_DAY = 24 * 60;
const BOOST_SCALE_BPS = 10_000;
const WINDOW_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function minuteOfDay(value) {
  if (typeof value !== "string") return null;
  const match = value.match(TIME_PATTERN);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** Parse one exact, same-day HH:MM-HH:MM window. */
export function parseAutoBoostTimeWindow(value) {
  if (typeof value !== "string") return null;
  const match = value.match(WINDOW_PATTERN);
  if (!match) return null;
  const startMinute = Number(match[1]) * 60 + Number(match[2]);
  const endMinute = Number(match[3]) * 60 + Number(match[4]);
  if (startMinute >= endMinute) return null;
  return {
    start: `${match[1]}:${match[2]}`,
    end: `${match[3]}:${match[4]}`
  };
}

/**
 * Validate and normalize 1-24 same-day campaign windows. The returned order is
 * chronological; callers should retain the submitted array separately if its
 * display order matters.
 */
export function validateAutoBoostWindows(windows) {
  if (!Array.isArray(windows) || windows.length < 1 || windows.length > 24) {
    throw new RangeError("Auto Boost requires between 1 and 24 time windows");
  }
  const normalized = windows.map((window, index) => {
    if (!window || typeof window !== "object" || Array.isArray(window)) {
      throw new TypeError(`Auto Boost window ${index + 1} must be an object`);
    }
    const startMinute = minuteOfDay(window.start);
    const endMinute = minuteOfDay(window.end);
    if (startMinute === null || endMinute === null) {
      throw new RangeError(`Auto Boost window ${index + 1} must use HH:MM`);
    }
    if (startMinute >= endMinute) {
      throw new RangeError(`Auto Boost window ${index + 1} must start and end on the same day`);
    }
    return {
      start: window.start,
      end: window.end,
      startMinute,
      endMinute
    };
  });
  return normalized.sort((left, right) =>
    left.startMinute - right.startMinute || left.endMinute - right.endMinute
  );
}

/**
 * Convert campaign windows into effective [start-lead,end) intervals and merge
 * every overlapping or touching interval. Minutes may be negative when the lead
 * begins on the previous Bangkok calendar day.
 */
export function mergeEffectiveIntervals(windows, leadMinutes) {
  if (!Number.isSafeInteger(leadMinutes) || leadMinutes < 0 || leadMinutes > MINUTES_PER_DAY) {
    throw new RangeError("leadMinutes must be an integer between 0 and 1440");
  }
  const effective = validateAutoBoostWindows(windows)
    .map((window) => ({
      startMinute: window.startMinute - leadMinutes,
      endMinute: window.endMinute
    }))
    .sort((left, right) => left.startMinute - right.startMinute || left.endMinute - right.endMinute);

  const merged = [];
  for (const interval of effective) {
    const previous = merged.at(-1);
    if (previous && interval.startMinute <= previous.endMinute) {
      previous.endMinute = Math.max(previous.endMinute, interval.endMinute);
      continue;
    }
    merged.push({ ...interval });
  }
  return merged;
}

/** Convert a percentage with at most two decimals to integer basis points. */
export function percentToBasisPoints(percent) {
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent <= 0) {
    throw new RangeError("boost percent must be a positive number");
  }
  const boostBps = Math.round(percent * 100);
  if (Math.abs(percent * 100 - boostBps) > 1e-8 || !Number.isSafeInteger(boostBps)) {
    throw new RangeError("boost percent supports at most two decimal places");
  }
  return boostBps;
}

/**
 * Calculate the target once from the stored base amount. Both input and output
 * are minor currency units; passing a previously boosted amount is never needed.
 */
export function calculateAutoBoostTargetMinor(baseBudgetMinor, boostBps) {
  if (!Number.isSafeInteger(baseBudgetMinor) || baseBudgetMinor <= 0) {
    throw new RangeError("baseBudgetMinor must be a positive safe integer");
  }
  if (!Number.isSafeInteger(boostBps) || boostBps <= 0) {
    throw new RangeError("boostBps must be a positive safe integer");
  }
  const numerator = BigInt(baseBudgetMinor) * (BigInt(BOOST_SCALE_BPS) + BigInt(boostBps));
  const rounded = (numerator + BigInt(BOOST_SCALE_BPS / 2)) / BigInt(BOOST_SCALE_BPS);
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("Auto Boost target exceeds the safe integer range");
  }
  return Number(rounded);
}

function bangkokMidnightUtcMs(localDate) {
  if (typeof localDate !== "string") throw new TypeError("localDate must use YYYY-MM-DD");
  const match = localDate.match(DATE_PATTERN);
  if (!match) throw new RangeError("localDate must use YYYY-MM-DD");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new RangeError("localDate is not a valid calendar date");
  }
  // Thailand is UTC+07:00 and does not observe daylight-saving time.
  return Date.UTC(year, month - 1, day) - 7 * 60 * 60_000;
}

/** Convert a Bangkok local date and HH:MM time to its UTC instant. */
export function bangkokDateTimeToInstant(localDate, localTime) {
  const minutes = minuteOfDay(localTime);
  if (minutes === null) throw new RangeError("localTime must use HH:MM");
  return new Date(bangkokMidnightUtcMs(localDate) + minutes * 60_000);
}

/** Return the YYYY-MM-DD calendar date at a given instant in Bangkok. */
export function bangkokLocalDate(value = new Date()) {
  const instant = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(instant.getTime())) throw new RangeError("value must be a valid instant");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: AUTO_BOOST_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(instant);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

/**
 * Resolve the merged effective daily blocks to durable UTC ISO instants.
 * startAt is already lead-adjusted; consumers must not subtract lead again.
 */
export function buildBangkokDailyIntervals({ localDate, windows, leadMinutes }) {
  const midnight = bangkokMidnightUtcMs(localDate);
  return mergeEffectiveIntervals(windows, leadMinutes).map((interval, blockIndex) => ({
    blockIndex,
    startAt: new Date(midnight + interval.startMinute * 60_000).toISOString(),
    endAt: new Date(midnight + interval.endMinute * 60_000).toISOString()
  }));
}
