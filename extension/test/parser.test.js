import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

await import("../lib/tiktok-parser.js");
const parser = globalThis.WhaleBuddyTikTokParser;
const now = new Date("2026-07-20T12:00:00.000Z");
const expectedTikTokAccountId = "7285935731820920833";

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

function parse(model) {
  return parser.parseTableModel({
    ...model,
    expectedTikTokAccountId,
    expectedCampaignStart: "06:00:00",
    now
  });
}

function throwsCode(code) {
  return (error) => error instanceof parser.ParserError && error.code === code;
}

test("parses the exact 22-column LIVE table by header name", async () => {
  const value = parse(await fixture("valid-table.json"));
  assert.deepEqual(value, {
    campaignName: "2026-07-20 06:00:00",
    campaignStatus: "ACTIVE",
    tiktokAccountId: expectedTikTokAccountId,
    currency: "THB",
    dailyBudgetMinor: 40_000,
    totalBudgetMinor: 40_000,
    costMinor: 32_550,
    netCostMinor: 30_025,
    grossRevenueMinor: 120_000,
    grossRoiMilli: 3_690,
    netRevenueMinor: 110_000,
    netRoiMilli: 3_660,
    gmvMinor: 120_000
  });
});

test("accepts only the known Consider increasing budget suffix", async () => {
  const model = await fixture("consider-increasing-table.json");
  const value = parse(model);
  assert.equal(value.dailyBudgetMinor, 500_000);
  assert.equal(value.costMinor, 462_284);
  assert.equal(value.grossRevenueMinor, 840_000);
  assert.equal(value.grossRoiMilli, 1_820);
  assert.equal(value.netRevenueMinor, 810_000);
  assert.equal(value.netRoiMilli, 1_800);
  assert.equal(value.gmvMinor, 840_000);

  model.rows[0][5] += " Click now";
  assert.throws(() => parse(model), throwsCode("MONEY_PARSE_ERROR"));
});

test("Cost never falls back to Net Cost", async () => {
  const model = await fixture("valid-table.json");
  model.headers[6] = "Net Cost";
  assert.throws(() => parse(model), throwsCode("TABLE_HEADER_INVALID"));
});

test("only exact optional headers are parsed; absent optional headers become null", async () => {
  const model = await fixture("valid-table.json");
  model.headers[model.headers.indexOf("Gross revenue")] = "Gross Revenue";
  const value = parse(model);
  assert.equal(value.grossRevenueMinor, null);
  assert.equal(value.grossRoiMilli, 3_690);
  assert.equal(value.netRevenueMinor, 110_000);
  assert.equal(value.netRoiMilli, 3_660);
  assert.equal(value.gmvMinor, 120_000);
});

test("malformed optional metric cells become null without suppressing core telemetry", async () => {
  const model = await fixture("valid-table.json");
  const malformed = {
    "Gross revenue": "not money",
    "Gross ROI": "3.6900",
    "Net revenue": "1,20.00 THB",
    "Net ROI": "N/A",
    GMV: "1200 USD"
  };
  for (const [header, value] of Object.entries(malformed)) {
    model.rows[0][model.headers.indexOf(header)] = value;
  }

  const value = parse(model);
  assert.equal(value.dailyBudgetMinor, 40_000);
  assert.equal(value.totalBudgetMinor, 40_000);
  assert.equal(value.costMinor, 32_550);
  assert.equal(value.netCostMinor, 30_025);
  assert.equal(value.grossRevenueMinor, null);
  assert.equal(value.grossRoiMilli, null);
  assert.equal(value.netRevenueMinor, null);
  assert.equal(value.netRoiMilli, null);
  assert.equal(value.gmvMinor, null);
});

test("known no-data metric placeholders become null", async () => {
  const model = await fixture("valid-table.json");
  const placeholders = {
    "Gross revenue": "-",
    "Gross ROI": "--",
    "Net revenue": "—",
    "Net ROI": "-",
    GMV: "--"
  };
  for (const [header, placeholder] of Object.entries(placeholders)) {
    model.rows[0][model.headers.indexOf(header)] = placeholder;
  }
  const value = parse(model);
  assert.equal(value.grossRevenueMinor, null);
  assert.equal(value.grossRoiMilli, null);
  assert.equal(value.netRevenueMinor, null);
  assert.equal(value.netRoiMilli, null);
  assert.equal(value.gmvMinor, null);
});

test("ROI parser uses exact thousandths and rejects ambiguous text", () => {
  assert.equal(parser.ROI_SCALE, 1_000);
  assert.equal(parser.parseRoiMilli("3.69", "roi"), 3_690);
  assert.equal(parser.parseRoiMilli("1.234", "roi"), 1_234);
  assert.equal(parser.parseRoiMilli("1,234.567", "roi"), 1_234_567);
  assert.equal(parser.parseRoiMilli("0", "roi"), 0);
  for (const placeholder of ["-", "--", "—"]) {
    assert.equal(parser.parseRoiMilli(placeholder, "roi"), null);
  }
  for (const invalid of ["03.69", "1,23.4", "+3.69", "-3.69", "3.6900", "3.69x", "N/A"]) {
    assert.throws(() => parser.parseRoiMilli(invalid, "roi"), throwsCode("ROI_PARSE_ERROR"));
  }
});

test("fails closed on missing headers and row shape drift", async () => {
  const missing = await fixture("valid-table.json");
  missing.headers[16] = "Lifetime budget";
  assert.throws(() => parse(missing), throwsCode("TABLE_HEADER_INVALID"));

  const shortRow = await fixture("valid-table.json");
  shortRow.rows[0].pop();
  assert.throws(() => parse(shortRow), throwsCode("TABLE_SHAPE_CHANGED"));
});

test("requires the exact 06:00 campaign schedule", async () => {
  const model = await fixture("valid-table.json");
  model.rows[0][1] = "2026-07-20 12:00:00";
  assert.throws(() => parse(model), throwsCode("CAMPAIGN_NOT_FOUND"));
});

test("requires exactly one ID token in the account cell", async () => {
  const model = await fixture("valid-table.json");
  model.rows[0][3] += " ID: 7285935731820920999";
  assert.throws(() => parse(model), throwsCode("ACCOUNT_ID_MISMATCH"));
});

test("requires exactly one active campaign row", async () => {
  const model = await fixture("valid-table.json");
  model.rows.push([...model.rows[0]]);
  assert.throws(() => parse(model), throwsCode("CAMPAIGN_AMBIGUOUS"));
});

test("THB parser rejects loose grouping, other currencies, and extra text", () => {
  assert.equal(parser.parseThbMinor("5,000.00 THB", "money"), 500_000);
  assert.equal(parser.parseThbMinor("400.5 THB", "money"), 40_050);
  for (const invalid of ["5,00.00 THB", "5000.000 THB", "5000 USD", "5000 THB extra", "-1 THB"]) {
    assert.throws(() => parser.parseThbMinor(invalid, "money"), throwsCode("MONEY_PARSE_ERROR"));
  }
});
