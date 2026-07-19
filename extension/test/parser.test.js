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
    netCostMinor: 30_025
  });
});

test("accepts only the known Consider increasing budget suffix", async () => {
  const model = await fixture("consider-increasing-table.json");
  const value = parse(model);
  assert.equal(value.dailyBudgetMinor, 500_000);
  assert.equal(value.costMinor, 462_284);

  model.rows[0][5] += " Click now";
  assert.throws(() => parse(model), throwsCode("MONEY_PARSE_ERROR"));
});

test("Cost never falls back to Net Cost", async () => {
  const model = await fixture("valid-table.json");
  model.headers[6] = "Net Cost";
  assert.throws(() => parse(model), throwsCode("TABLE_HEADER_INVALID"));
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
