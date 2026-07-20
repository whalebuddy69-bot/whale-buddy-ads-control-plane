(function installWhaleBuddyParser(root) {
  "use strict";

  const EXPECTED_COLUMN_COUNT = 22;
  // ROI values are represented exactly as thousandths. For example, the
  // visible value `3.69` becomes 3_690 and `1.234` becomes 1_234.
  const ROI_SCALE = 1_000;
  const NO_DATA_PLACEHOLDERS = Object.freeze(["-", "--", "—"]);
  const REQUIRED_HEADERS = Object.freeze({
    campaignName: "Campaign name",
    campaignStatus: "Status",
    tiktokAccountId: "Available TikTok accounts",
    dailyBudgetMinor: "Target ROI budget",
    costMinor: "Cost",
    totalBudgetMinor: "Total budget",
    netCostMinor: "Net Cost"
  });
  const OPTIONAL_HEADERS = Object.freeze({
    grossRevenueMinor: "Gross revenue",
    grossRoiMilli: "Gross ROI",
    netRevenueMinor: "Net revenue",
    netRoiMilli: "Net ROI",
    gmvMinor: "GMV"
  });

  class ParserError extends Error {
    constructor(code, message, details) {
      super(message);
      this.name = "ParserError";
      this.code = code;
      if (details !== undefined) this.details = details;
    }
  }

  function fail(code, message, details) {
    throw new ParserError(code, message, details);
  }

  function normalizeText(value) {
    return String(value ?? "")
      .normalize("NFKC")
      .replace(/[\u00a0\u2007\u202f]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
  }

  function parseThbMinor(value, field) {
    const text = normalizeText(value);
    const match = text.match(/^((?:0|[1-9]\d*)|(?:[1-9]\d{0,2}(?:,\d{3})+))(?:\.(\d{1,2}))? THB$/u);
    if (!match) fail("MONEY_PARSE_ERROR", `${field} ไม่ใช่จำนวนเงิน THB ที่รองรับ`, { field });
    const major = Number(match[1].replaceAll(",", ""));
    const fraction = (match[2] ?? "").padEnd(2, "0");
    const minor = major * 100 + Number(fraction || "0");
    if (!Number.isSafeInteger(minor) || minor < 0) {
      fail("MONEY_PARSE_ERROR", `${field} มีค่ามากเกินขอบเขต`, { field });
    }
    return minor;
  }

  function isNoDataPlaceholder(value) {
    return NO_DATA_PLACEHOLDERS.includes(normalizeText(value));
  }

  function parseNullableThbMinor(value, field) {
    if (isNoDataPlaceholder(value)) return null;
    return parseThbMinor(value, field);
  }

  function parseRoiMilli(value, field) {
    const text = normalizeText(value);
    if (isNoDataPlaceholder(text)) return null;
    const match = text.match(/^((?:0|[1-9]\d*)|(?:[1-9]\d{0,2}(?:,\d{3})+))(?:\.(\d{1,3}))?$/u);
    if (!match) {
      fail("ROI_PARSE_ERROR", `${field} ไม่ใช่ค่า ROI ที่รองรับ`, { field });
    }
    const whole = Number(match[1].replaceAll(",", ""));
    const fraction = Number((match[2] ?? "").padEnd(3, "0") || "0");
    const milli = whole * ROI_SCALE + fraction;
    if (!Number.isSafeInteger(milli) || milli < 0) {
      fail("ROI_PARSE_ERROR", `${field} มีค่ามากเกินขอบเขต`, { field });
    }
    return milli;
  }

  function parseDailyBudgetMinor(value) {
    const text = normalizeText(value);
    const marker = "Daily budget:";
    const parts = text.split(marker);
    if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) {
      fail("MONEY_PARSE_ERROR", "ไม่พบป้าย Daily budget: แบบชัดเจน", { field: "dailyBudgetMinor" });
    }
    const approvedSuffix = parts[1].match(/^(.+? THB)(?: Consider increasing)?$/u);
    if (!approvedSuffix) {
      fail("MONEY_PARSE_ERROR", "ข้อความต่อท้าย Daily budget: ไม่อยู่ในรูปแบบที่อนุญาต", {
        field: "dailyBudgetMinor"
      });
    }
    const minor = parseThbMinor(approvedSuffix[1], "dailyBudgetMinor");
    if (minor === 0) fail("MONEY_PARSE_ERROR", "Daily budget ต้องมากกว่าศูนย์", { field: "dailyBudgetMinor" });
    return minor;
  }

  function dateInBangkok(now) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Bangkok",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date(now));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }

  function accountIds(text) {
    return [...normalizeText(text).matchAll(/\bID:\s*(\d{6,32})\b/gu)]
      .map((match) => match[1]);
  }

  function buildHeaderMap(headers) {
    if (!Array.isArray(headers) || headers.length !== EXPECTED_COLUMN_COUNT) {
      fail("TABLE_SHAPE_CHANGED", "จำนวนหัวตารางไม่เท่ากับ 22", {
        actual: Array.isArray(headers) ? headers.length : null
      });
    }
    const map = new Map();
    headers.forEach((header, index) => {
      const normalized = normalizeText(header);
      if (map.has(normalized)) {
        fail("TABLE_HEADER_INVALID", "พบชื่อหัวตารางซ้ำ", { header: normalized });
      }
      map.set(normalized, index);
    });
    const indexes = {};
    for (const [semantic, visibleHeader] of Object.entries(REQUIRED_HEADERS)) {
      if (!map.has(visibleHeader)) {
        fail("TABLE_HEADER_INVALID", "หัวตารางสำคัญหายไป", { header: visibleHeader });
      }
      indexes[semantic] = map.get(visibleHeader);
    }
    if (indexes.costMinor === indexes.netCostMinor) {
      fail("COST_NET_COST_AMBIGUOUS", "Cost และ Net Cost ชี้ไปคอลัมน์เดียวกัน");
    }
    for (const [semantic, visibleHeader] of Object.entries(OPTIONAL_HEADERS)) {
      indexes[semantic] = map.has(visibleHeader) ? map.get(visibleHeader) : null;
    }
    return indexes;
  }

  function parseOptionalMetric(row, index, parser) {
    if (!Number.isInteger(index)) return null;
    try {
      return parser(row[index]);
    } catch (error) {
      // Revenue/ROI/GMV enrich the core budget observation. TikTok sometimes
      // changes or withholds these cells, so one malformed optional metric must
      // not suppress otherwise valid budget and cost telemetry.
      if (error instanceof ParserError) return null;
      throw error;
    }
  }

  function parseTableModel({
    headers,
    rows,
    expectedTikTokAccountId,
    expectedCampaignStart,
    now = new Date()
  }) {
    if (!/^\d{6,32}$/u.test(String(expectedTikTokAccountId ?? ""))) {
      fail("ACCOUNT_ID_MISMATCH", "TikTok account ที่กำหนดไม่ถูกต้อง");
    }
    if (!/^\d{2}:\d{2}:\d{2}$/u.test(String(expectedCampaignStart ?? ""))) {
      fail("INVALID_BINDING", "เวลาเริ่มแคมเปญที่กำหนดไม่ถูกต้อง");
    }
    const indexes = buildHeaderMap(headers);
    if (!Array.isArray(rows)) fail("TABLE_SHAPE_CHANGED", "ไม่พบแถวข้อมูล");
    for (const [rowIndex, row] of rows.entries()) {
      if (!Array.isArray(row) || row.length !== EXPECTED_COLUMN_COUNT) {
        fail("TABLE_SHAPE_CHANGED", "จำนวนช่องในแถวไม่เท่ากับหัวตาราง", {
          rowIndex,
          actual: Array.isArray(row) ? row.length : null
        });
      }
    }

    const localDate = dateInBangkok(now);
    const candidates = rows.filter((row) => {
      const name = normalizeText(row[indexes.campaignName]);
      const status = normalizeText(row[indexes.campaignStatus]);
      return status === "Active" &&
        name === `${localDate} ${expectedCampaignStart}`;
    });
    if (candidates.length === 0) {
      fail("CAMPAIGN_NOT_FOUND", "ไม่พบ LIVE campaign ที่ Active ของวันนี้");
    }
    if (candidates.length !== 1) {
      fail("CAMPAIGN_AMBIGUOUS", "พบ LIVE campaign ที่ตรงเงื่อนไขมากกว่าหนึ่งรายการ", {
        count: candidates.length
      });
    }

    const row = candidates[0];
    const observedAccountIds = accountIds(row[indexes.tiktokAccountId]);
    if (observedAccountIds.length !== 1 || observedAccountIds[0] !== expectedTikTokAccountId) {
      fail("ACCOUNT_ID_MISMATCH", "TikTok account ในแถวไม่ตรงบัญชีที่อนุญาต", {
        count: observedAccountIds.length
      });
    }
    const dailyBudgetMinor = parseDailyBudgetMinor(row[indexes.dailyBudgetMinor]);
    const totalBudgetMinor = parseThbMinor(row[indexes.totalBudgetMinor], "totalBudgetMinor");
    if (totalBudgetMinor === 0) {
      fail("MONEY_PARSE_ERROR", "Total budget ต้องมากกว่าศูนย์", { field: "totalBudgetMinor" });
    }
    return Object.freeze({
      campaignName: normalizeText(row[indexes.campaignName]),
      campaignStatus: "ACTIVE",
      tiktokAccountId: String(expectedTikTokAccountId),
      currency: "THB",
      dailyBudgetMinor,
      totalBudgetMinor,
      // Cost and Net Cost are intentionally selected by two different exact
      // headers. Never replace either lookup with a fuzzy `includes("Cost")`.
      costMinor: parseThbMinor(row[indexes.costMinor], "costMinor"),
      netCostMinor: parseThbMinor(row[indexes.netCostMinor], "netCostMinor"),
      grossRevenueMinor: parseOptionalMetric(
        row,
        indexes.grossRevenueMinor,
        (value) => parseNullableThbMinor(value, "grossRevenueMinor")
      ),
      grossRoiMilli: parseOptionalMetric(
        row,
        indexes.grossRoiMilli,
        (value) => parseRoiMilli(value, "grossRoiMilli")
      ),
      netRevenueMinor: parseOptionalMetric(
        row,
        indexes.netRevenueMinor,
        (value) => parseNullableThbMinor(value, "netRevenueMinor")
      ),
      netRoiMilli: parseOptionalMetric(
        row,
        indexes.netRoiMilli,
        (value) => parseRoiMilli(value, "netRoiMilli")
      ),
      gmvMinor: parseOptionalMetric(
        row,
        indexes.gmvMinor,
        (value) => parseNullableThbMinor(value, "gmvMinor")
      )
    });
  }

  root.WhaleBuddyTikTokParser = Object.freeze({
    EXPECTED_COLUMN_COUNT,
    ROI_SCALE,
    NO_DATA_PLACEHOLDERS,
    REQUIRED_HEADERS,
    OPTIONAL_HEADERS,
    ParserError,
    normalizeText,
    parseThbMinor,
    parseNullableThbMinor,
    parseRoiMilli,
    parseDailyBudgetMinor,
    dateInBangkok,
    buildHeaderMap,
    parseTableModel
  });
})(globalThis);
