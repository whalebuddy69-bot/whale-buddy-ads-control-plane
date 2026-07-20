import crypto from "node:crypto";

import { parseAutoBoostTimeWindow } from "./auto-boost.js";

const CONTROL_REQUEST_ID = /^ca_[A-Za-z0-9-]{16,80}$/;
const SHORTCUT_NAME = /^[A-Za-z0-9ก-๙_-]{1,32}$/u;
const CLIENT_ALIAS = /^[A-Za-z0-9ก-๙_.-]{1,80}$/u;
const CAROUSEL_PAGE_SIZE = 10;

function cleanText(value) {
  return String(value ?? "").normalize("NFKC").trim();
}

function parseAmount(value) {
  const normalized = cleanText(value).replace(/[฿,]/g, "");
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function parseRoi(value) {
  const normalized = cleanText(value);
  if (!/^\d+(?:\.\d{1,3})?$/.test(normalized)) return null;
  const roi = Number(normalized);
  return Number.isFinite(roi) && roi > 0 ? roi : null;
}

function commandClientAlias(value) {
  const alias = cleanText(value);
  return CLIENT_ALIAS.test(alias) ? alias : null;
}

function commandShortcutName(value) {
  const name = cleanText(value);
  return SHORTCUT_NAME.test(name) ? name : null;
}

function parseShortcutDefinition(text) {
  const lines = String(text).replace(/\r/g, "").split("\n").map(cleanText).filter(Boolean);
  const header = lines[0]?.match(/^(?:ตั้ง\s*shortcut|shortcut)\s+(\S+)\s+(\S+)$/iu);
  if (!header || lines.length < 5) return null;
  const clientAlias = commandClientAlias(header[1]);
  const shortcutName = commandShortcutName(header[2]);
  if (!clientAlias || !shortcutName) return null;

  const values = {};
  for (const line of lines.slice(1)) {
    let match = line.match(/^ชื่อ\s+(.{1,120})$/u);
    if (match) {
      if (values.campaignNameTemplate !== undefined) return null;
      values.campaignNameTemplate = cleanText(match[1]);
      continue;
    }
    match = line.match(/^งบ\s+(.+)$/u);
    if (match) {
      if (values.dailyBudget !== undefined) return null;
      values.dailyBudget = parseAmount(match[1]);
      if (values.dailyBudget === null) return null;
      continue;
    }
    match = line.match(/^ROI\s+(.+)$/iu);
    if (match) {
      if (values.targetRoi !== undefined) return null;
      values.targetRoi = parseRoi(match[1]);
      if (values.targetRoi === null) return null;
      continue;
    }
    match = line.match(/^เติม(?:งบ)?เมื่อ\s+(\d{1,2}(?:\.\d{1,2})?)\s*%?$/u);
    if (match) {
      if (values.topUpThresholdPercent !== undefined) return null;
      values.topUpThresholdPercent = Number(match[1]);
      continue;
    }
    return null;
  }
  if (
    !values.campaignNameTemplate ||
    values.dailyBudget == null ||
    values.targetRoi == null ||
    values.topUpThresholdPercent == null
  ) return null;
  return { kind: "shortcut_upsert", clientAlias, shortcutName, ...values };
}

function parseAutoBoostDefinition(text) {
  const lines = String(text).replace(/\r/g, "").split("\n").map(cleanText).filter(Boolean);
  const header = lines[0]?.match(/^ตั้ง\s+Auto\s+Boost\s+(\S+)$/iu);
  if (!header || lines.length < 6 || lines[4] !== "ช่วงเวลา") return null;
  const clientAlias = commandClientAlias(header[1]);
  if (!clientAlias) return null;

  const baseMatch = lines[1].match(/^งบฐาน\s+(.+)$/u);
  const boostMatch = lines[2].match(/^เพิ่ม\s+(\d+(?:\.\d{1,2})?)\s*%$/u);
  const leadMatch = lines[3].match(/^ก่อน\s+(\d{1,4})\s*นาที$/u);
  if (!baseMatch || !boostMatch || !leadMatch) return null;

  const baseBudget = parseAmount(baseMatch[1]);
  const boostPercent = Number(boostMatch[1]);
  const leadMinutes = Number(leadMatch[1]);
  if (
    baseBudget === null ||
    !Number.isFinite(boostPercent) || boostPercent <= 0 || boostPercent > 1_000 ||
    !Number.isSafeInteger(leadMinutes) || leadMinutes < 1 || leadMinutes > 1_440
  ) return null;

  const windowLines = lines.slice(5);
  if (windowLines.length < 1 || windowLines.length > 24) return null;
  const windows = windowLines.map(parseAutoBoostTimeWindow);
  if (windows.some((window) => window === null)) return null;
  return {
    kind: "auto_boost_upsert",
    clientAlias,
    baseBudget,
    boostPercent,
    leadMinutes,
    windows
  };
}

/**
 * Exact, bounded LINE commands for campaign operations. Advertiser, BC, Shop,
 * and TikTok account identities are deliberately never accepted from chat.
 */
export function parseControlCommand(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > 800) return null;
  const value = cleanText(text);
  const shortcut = parseShortcutDefinition(text);
  if (shortcut) return shortcut;
  const autoBoost = parseAutoBoostDefinition(text);
  if (autoBoost) return autoBoost;

  if (/^(?:เมนู|menu|เริ่มต้น|start)$/iu.test(value)) {
    return { kind: "agency_menu" };
  }
  const reportPageMatch = value.match(
    /^(?:(?:อัปเดต|อัพเดท|ดู)\s*(?:Report|รายงาน)\s*(?:ล่าสุด|ทั้งหมด)|รายงานทั้งหมด)(?:\s+หน้า\s+(\d{1,4}))?$/iu
  );
  if (reportPageMatch) {
    const page = Number(reportPageMatch[1] ?? 1);
    return page >= 1 ? { kind: "agency_report", ...(page > 1 ? { page } : {}) } : null;
  }
  const createPageMatch = value.match(/^(?:สร้างแคมเปญ(?:ใหม่)?|สร้างแอด)(?:\s+หน้า\s+(\d{1,4}))?$/u);
  if (createPageMatch) {
    const page = Number(createPageMatch[1] ?? 1);
    return page >= 1
      ? { kind: "agency_section", section: "create", ...(page > 1 ? { page } : {}) }
      : null;
  }
  const closePageMatch = value.match(/^ปิดแคมเปญ(?:\s+หน้า\s+(\d{1,4}))?$/u);
  if (closePageMatch) {
    const page = Number(closePageMatch[1] ?? 1);
    return page >= 1
      ? { kind: "agency_section", section: "close", ...(page > 1 ? { page } : {}) }
      : null;
  }
  const adjustPageMatch = value.match(/^(?:ปรับข้อมูล|ปรับ\s*เพิ่ม\s*\/\s*ลด(?:\s*ข้อมูล)?|ปรับเพิ่มลดข้อมูล|ปรับเพิ่มลด)(?:\s+หน้า\s+(\d{1,4}))?$/u);
  if (adjustPageMatch) {
    const page = Number(adjustPageMatch[1] ?? 1);
    return page >= 1
      ? { kind: "agency_section", section: "adjust", ...(page > 1 ? { page } : {}) }
      : null;
  }
  const autoBoostPageMatch = value.match(/^(?:ตั้งค่า\s*)?Auto\s+Boost(?:\s+หน้า\s+(\d{1,4}))?$/iu);
  if (autoBoostPageMatch) {
    const page = Number(autoBoostPageMatch[1] ?? 1);
    return page >= 1
      ? { kind: "agency_section", section: "auto_boost", ...(page > 1 ? { page } : {}) }
      : null;
  }

  let match = value.match(/^(?:สร้างแคมเปญ|สร้างแอด)\s+(\S+)$/u);
  if (match) {
    const clientAlias = commandClientAlias(match[1]);
    return clientAlias ? { kind: "campaign_create_template", clientAlias } : null;
  }
  match = value.match(/^ปิดแคมเปญ\s+(\S+)$/u);
  if (match) {
    const clientAlias = commandClientAlias(match[1]);
    return clientAlias ? { kind: "campaign_close_menu", clientAlias } : null;
  }
  match = value.match(/^(?:ปรับข้อมูล|ปรับเพิ่มลด)\s+(\S+)$/u);
  if (match) {
    const clientAlias = commandClientAlias(match[1]);
    return clientAlias ? { kind: "campaign_adjust_menu", clientAlias } : null;
  }
  match = value.match(/^ตั้งค่า\s+Auto\s+Boost\s+(\S+)$/iu);
  if (match) {
    const clientAlias = commandClientAlias(match[1]);
    return clientAlias ? { kind: "auto_boost_setup", clientAlias } : null;
  }

  match = value.match(/^ดู\s+Auto\s+Boost\s+(\S+)$/iu);
  if (match) {
    const clientAlias = commandClientAlias(match[1]);
    return clientAlias ? { kind: "auto_boost_status", clientAlias } : null;
  }
  match = value.match(/^(เปิด|ปิด)\s+Auto\s+Boost\s+(\S+)$/iu);
  if (match) {
    const clientAlias = commandClientAlias(match[2]);
    return clientAlias
      ? { kind: "auto_boost_toggle", clientAlias, enabled: match[1] === "เปิด" }
      : null;
  }

  match = value.match(/^(?:เมนู|menu)\s+(\S+)$/iu);
  if (match) {
    const clientAlias = commandClientAlias(match[1]);
    return clientAlias ? { kind: "menu", clientAlias } : null;
  }
  if (CLIENT_ALIAS.test(value)) return { kind: "menu", clientAlias: value };

  match = value.match(/^(?:วิธีใช้|help)\s+(\S+)$/iu);
  if (match) {
    const clientAlias = commandClientAlias(match[1]);
    return clientAlias ? { kind: "help", clientAlias } : null;
  }

  match = value.match(/^(?:สถานะ|status|รายงานตอนนี้)\s+(\S+)$/iu);
  if (match) {
    const clientAlias = commandClientAlias(match[1]);
    return clientAlias ? { kind: "status", clientAlias } : null;
  }
  match = value.match(/^รายงาน\s+(\S+)\s+ทุก\s+(\d{1,2})\s*ชั่วโมง$/u);
  if (match) {
    const clientAlias = commandClientAlias(match[1]);
    const intervalHours = Number(match[2]);
    return clientAlias && intervalHours >= 1 && intervalHours <= 24
      ? { kind: "report_subscribe", clientAlias, intervalHours }
      : null;
  }
  match = value.match(/^หยุดรายงาน\s+(\S+)$/u);
  if (match) {
    const clientAlias = commandClientAlias(match[1]);
    return clientAlias ? { kind: "report_unsubscribe", clientAlias } : null;
  }
  match = value.match(/^ดู\s*shortcut\s+(\S+)$/iu);
  if (match) {
    const clientAlias = commandClientAlias(match[1]);
    return clientAlias ? { kind: "shortcut_list", clientAlias } : null;
  }
  match = value.match(/^(?:ใช้\s*shortcut|เปิด)\s+(\S+)\s+(\S+)$/iu);
  if (match) {
    const clientAlias = commandClientAlias(match[1]);
    const shortcutName = commandShortcutName(match[2]);
    return clientAlias && shortcutName
      ? { kind: "action", action: "CREATE_FROM_SHORTCUT", clientAlias, shortcutName }
      : null;
  }
  match = value.match(/^(ตั้งงบ|งบใหม่|เพิ่มงบ|ลดงบ)\s+(\S+)\s+(.+)$/u);
  if (match) {
    const clientAlias = commandClientAlias(match[2]);
    const amount = parseAmount(match[3]);
    const relative = new Set(["เพิ่มงบ", "ลดงบ"]).has(match[1]);
    if (!clientAlias || amount === null) {
      return { kind: "invalid_template", template: "adjustment" };
    }
    return relative
      ? {
          kind: "action",
          action: "ADJUST_BUDGET",
          clientAlias,
          amount,
          direction: match[1] === "เพิ่มงบ" ? 1 : -1
        }
      : { kind: "action", action: "UPDATE_BUDGET", clientAlias, amount };
  }
  match = value.match(/^ตั้ง\s*ROI\s+(\S+)\s+(.+)$/iu);
  if (match) {
    const clientAlias = commandClientAlias(match[1]);
    const targetRoi = parseRoi(match[2]);
    return clientAlias && targetRoi !== null
      ? { kind: "action", action: "UPDATE_ROI", clientAlias, targetRoi }
      : { kind: "invalid_template", template: "adjustment" };
  }
  match = value.match(/^(?:พัก|ปิด)\s+(\S+)$/u);
  if (match) {
    const clientAlias = commandClientAlias(match[1]);
    return clientAlias ? { kind: "action", action: "PAUSE", clientAlias } : null;
  }
  match = value.match(/^เปิดใหม่\s+(\S+)$/u);
  if (match) {
    const clientAlias = commandClientAlias(match[1]);
    return clientAlias ? { kind: "action", action: "RESUME", clientAlias } : null;
  }
  match = value.match(
    /^คูปอง\s+(\S+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+ก่อน\s+(\d{1,3})\s*นาที\s+งบ\s+(.+)$/u
  );
  if (match) {
    const clientAlias = commandClientAlias(match[1]);
    const leadMinutes = Number(match[4]);
    const amount = parseAmount(match[5]);
    return clientAlias && leadMinutes >= 5 && leadMinutes <= 180 && amount !== null
      ? {
          kind: "coupon_schedule",
          clientAlias,
          localDate: match[2],
          localTime: match[3],
          leadMinutes,
          amount
        }
      : null;
  }
  match = value.match(/^ยกเลิกคูปอง\s+(\S+)$/u);
  if (match) {
    const clientAlias = commandClientAlias(match[1]);
    return clientAlias ? { kind: "coupon_cancel", clientAlias } : null;
  }
  if (/^ตั้ง\s*shortcut(?:\s|$)/iu.test(value)) {
    return { kind: "invalid_template", template: "shortcut" };
  }
  if (/^ตั้ง\s+Auto\s+Boost(?:\s|$)/iu.test(value)) {
    return { kind: "invalid_template", template: "auto_boost" };
  }
  if (/^(?:ตั้งงบ|งบใหม่|เพิ่มงบ|ลดงบ|ตั้ง\s*ROI)(?:\s|$)/iu.test(value)) {
    return { kind: "invalid_template", template: "adjustment" };
  }
  return null;
}

export function parseControlPostbackData(data) {
  if (typeof data !== "string" || data.length === 0 || data.length > 300) return null;
  const params = new URLSearchParams(data);
  const action = params.get("op");
  const requestId = params.get("id");
  const version = Number(params.get("v"));
  if (!new Set(["confirm", "reject"]).has(action)) return null;
  if (!CONTROL_REQUEST_ID.test(requestId ?? "")) return null;
  if (!Number.isSafeInteger(version) || version < 1) return null;
  return { action, requestId, version };
}

export function newControlRequestId() {
  return `ca_${crypto.randomUUID()}`;
}

function lineText(text, options = {}) {
  return { type: "text", text, wrap: true, ...options };
}

function detailRow(label, value) {
  return {
    type: "box",
    layout: "baseline",
    spacing: "sm",
    contents: [
      lineText(label, { size: "sm", color: "#777777", flex: 5 }),
      lineText(String(value), { size: "sm", color: "#111111", flex: 7, align: "end" })
    ]
  };
}

function accountSuffix(advertiserId) {
  const id = String(advertiserId ?? "");
  return id ? `••••${id.slice(-4)}` : "—";
}

export function formatMinor(minor, currency = "THB") {
  if (!Number.isSafeInteger(minor)) return "—";
  return new Intl.NumberFormat("th-TH", {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  }).format(minor / 100);
}

function formatRoiMilli(value) {
  if (!Number.isSafeInteger(value)) return "—";
  return (value / 1000).toLocaleString("th-TH", { maximumFractionDigits: 3 });
}

function bangkokTime(value) {
  return new Date(value).toLocaleString("th-TH", {
    timeZone: "Asia/Bangkok",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function primaryAlias(client) {
  return cleanText(client?.lineControl?.aliases?.[0] ?? client?.name ?? client?.id ?? "");
}

function shortLabel(value, maximum = 20) {
  const characters = Array.from(cleanText(value));
  return characters.length <= maximum
    ? characters.join("")
    : `${characters.slice(0, Math.max(1, maximum - 1)).join("")}…`;
}

function messageAction(label, text) {
  return { type: "message", label: shortLabel(label), text };
}

function clipboardAction(label, clipboardText) {
  return { type: "clipboard", label: shortLabel(label), clipboardText };
}

function menuQuickReply() {
  return {
    items: [{ type: "action", action: messageAction("เมนูหลัก", "เมนู") }]
  };
}

function helpQuickReply(alias) {
  return {
    items: [
      { type: "action", action: messageAction("วิธีใช้ / Template", `วิธีใช้ ${alias}`) },
      { type: "action", action: messageAction("เมนู", "เมนู") }
    ]
  };
}

function paginationQuickReply({ page, pageCount, previousText, nextText }) {
  const items = [];
  if (page > 1) {
    items.push({ type: "action", action: messageAction("◀ หน้าก่อน", previousText) });
  }
  if (page < pageCount) {
    items.push({ type: "action", action: messageAction("หน้าถัดไป ▶", nextText) });
  }
  items.push({ type: "action", action: messageAction("เมนู", "เมนู") });
  return { items };
}

function snapshotAgeMinutes(snapshot, now = new Date()) {
  const ageMs = new Date(now).getTime() - Date.parse(snapshot?.observedAt);
  return Number.isFinite(ageMs) ? Math.max(0, Math.floor(ageMs / 60_000)) : null;
}

function snapshotSourceText(snapshot, now, stale) {
  if (!snapshot) return "ยังไม่มีข้อมูลจาก Chrome reader";
  const age = snapshotAgeMinutes(snapshot, now);
  return `${stale ? "⚠️ ข้อมูลเก่า" : "🟢 ข้อมูลล่าสุด"} · Chrome${age === null ? "" : ` · ${age} นาที`}`;
}

function defaultBudgetMinor(client) {
  const minimum = Math.round(Number(client?.lineControl?.minDailyBudget ?? 100) * 100);
  const maximum = Math.round(Number(client?.budgetPolicy?.maxDailyBudget ?? 6_000) * 100);
  return Math.min(maximum, Math.max(minimum, 300_000));
}

function plainMajor(minor) {
  return Number.isSafeInteger(minor) ? String(minor / 100) : "3000";
}

function autoBoostTemplateText(client, input = {}) {
  const alias = primaryAlias(client);
  const windows = Array.isArray(input.windows) && input.windows.length > 0
    ? input.windows
    : [{ start: "12:00", end: "13:00" }, { start: "20:00", end: "21:00" }];
  const boostPercent = Number.isSafeInteger(input.boostBps)
    ? input.boostBps / 100
    : Number(client?.lineControl?.autoBoost?.boostPercent ?? 10);
  const leadMinutes = Number(input.leadMinutes ?? client?.lineControl?.autoBoost?.leadMinutes ?? 10);
  return [
    `ตั้ง Auto Boost ${alias}`,
    `งบฐาน ${plainMajor(input.baseBudgetMinor ?? defaultBudgetMinor(client))}`,
    `เพิ่ม ${boostPercent}%`,
    `ก่อน ${leadMinutes} นาที`,
    "ช่วงเวลา",
    ...windows.map((window) => `${window.start}-${window.end}`)
  ].join("\n");
}

/** Agency-level LINE Command Center. It never embeds account or campaign IDs. */
export function buildAgencyControlMenuMessage({ clients = [] } = {}) {
  const clientCount = clients.length;
  return {
    type: "flex",
    altText: `Whale Buddy Ads · เมนูหลัก (${clientCount} บัญชี)`,
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#EAF7F0",
        contents: [
          lineText("🐋 Whale Buddy Ads", { weight: "bold", size: "xl", color: "#135C3B" }),
          lineText("LINE Command Center", { size: "sm", color: "#35745A", margin: "xs" })
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          detailRow("บัญชีที่มีสิทธิ์", clientCount),
          lineText("เลือกงานที่ต้องการ ระบบจะแสดงเฉพาะลูกค้าที่ LINE นี้มีสิทธิ์", {
            size: "sm", color: "#555555", wrap: true
          }),
          lineText("🧪 คำสั่งที่แก้ TikTok ยังเป็น DRY-RUN", {
            size: "xs", color: "#8A4B00", margin: "md"
          })
        ]
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          { type: "button", style: "primary", color: "#06C755", action: messageAction("สร้างแคมเปญใหม่", "สร้างแคมเปญใหม่") },
          { type: "button", action: messageAction("ปิดแคมเปญ", "ปิดแคมเปญ") },
          { type: "button", action: messageAction("ปรับเพิ่ม / ลด", "ปรับเพิ่ม / ลด") },
          { type: "button", action: messageAction("ตั้งค่า Auto Boost", "ตั้งค่า Auto Boost") },
          { type: "button", action: messageAction("Report ล่าสุด", "อัปเดต Report ล่าสุด") }
        ]
      }
    }
  };
}

const CLIENT_PICKER_SECTIONS = Object.freeze({
  create: { title: "สร้างแคมเปญใหม่", command: "สร้างแคมเปญ" },
  adjust: { title: "ปรับเพิ่ม / ลด", command: "ปรับข้อมูล" },
  auto_boost: { title: "ตั้งค่า Auto Boost", command: "ตั้งค่า Auto Boost" }
});

/** Quick Reply is capped at 13 actions: 10 clients, previous/next, and Menu. */
export function buildAgencyClientPickerMessage({ clients = [], section, page = 1 } = {}) {
  const definition = CLIENT_PICKER_SECTIONS[section];
  if (!definition) throw new RangeError("Unsupported LINE client-picker section");
  const pageCount = Math.max(1, Math.ceil(clients.length / 10));
  const currentPage = Math.min(pageCount, Math.max(1, Number.isSafeInteger(page) ? page : 1));
  const visible = clients.slice((currentPage - 1) * 10, currentPage * 10);
  const lines = [
    `${definition.title} — เลือกลูกค้า`,
    "กดชื่อบัญชีด้านล่าง",
    `หน้า ${currentPage}/${pageCount} · ทั้งหมด ${clients.length} บัญชี`
  ];
  if (visible.length === 0) lines.push("ยังไม่มีบัญชีที่เลือกได้");
  const navigation = paginationQuickReply({
    page: currentPage,
    pageCount,
    previousText: `${definition.title} หน้า ${currentPage - 1}`,
    nextText: `${definition.title} หน้า ${currentPage + 1}`
  }).items;
  return {
    type: "text",
    text: lines.join("\n"),
    quickReply: {
      items: [
        ...visible.map((client) => {
          const alias = primaryAlias(client);
          return {
            type: "action",
            action: messageAction(shortLabel(alias), `${definition.command} ${alias}`)
          };
        }),
        ...navigation
      ]
    }
  };
}

export function buildCampaignCreateTemplateMessage({ client, shortcuts = [] } = {}) {
  if (!client) throw new TypeError("client is required");
  const alias = primaryAlias(client);
  const currency = client.campaignSelector?.currency ?? "THB";
  const example = shortcuts[0];
  const template = [
    `ตั้ง shortcut ${alias} new`,
    "ชื่อ {date} {start}:00",
    `งบ ${plainMajor(example?.dailyBudgetMinor ?? defaultBudgetMinor(client))}`,
    `ROI ${Number.isSafeInteger(example?.targetRoiMilli) ? example.targetRoiMilli / 1000 : 3.5}`,
    `เติมเมื่อ ${Number.isSafeInteger(example?.topUpThresholdBps) ? example.topUpThresholdBps / 100 : 80}%`
  ].join("\n");
  const shortcutButtons = shortcuts.slice(0, 2).map((shortcut) => ({
    type: "button",
    action: messageAction(`เปิด ${shortcut.shortcutName}`, `เปิด ${alias} ${shortcut.shortcutName}`)
  }));
  const viewAllButton = shortcuts.length > 2
    ? [{ type: "button", action: messageAction("ดู Shortcut ทั้งหมด", `ดู shortcut ${alias}`) }]
    : [];
  return {
    type: "flex",
    altText: `สร้างแคมเปญใหม่ · ${client.name}`,
    contents: {
      type: "bubble",
      header: {
        type: "box", layout: "vertical", backgroundColor: "#EAF7F0",
        contents: [lineText(`➕ สร้างแคมเปญ — ${client.name}`, { weight: "bold", size: "lg", color: "#135C3B" })]
      },
      body: {
        type: "box", layout: "vertical", spacing: "sm", contents: [
          detailRow("เพดานงบ", formatMinor(Math.round(client.budgetPolicy.maxDailyBudget * 100), currency)),
          detailRow("Shortcut", `${shortcuts.length} รายการ`),
          lineText("ขั้น 1: คัดลอก Template แล้วแก้ชื่อ Shortcut, งบ, ROI และจุดเติมงบ", {
            size: "sm", color: "#555555", margin: "md"
          }),
          lineText("คงบรรทัด “ชื่อ {date} {start}:00” ไว้เหมือนเดิมระหว่างใช้ Chrome reader", {
            size: "xs", color: "#8A4B00", margin: "sm"
          }),
          lineText("ขั้น 2: หลังบันทึกแล้ว กดเปิด Shortcut เพื่อเข้าหน้าพรีวิว", {
            size: "sm", color: "#555555", margin: "sm"
          }),
          lineText("ชื่อ Ad และชื่อช่องยังล็อกจาก config; จะเปิดให้เลือกหลัง TikTok API ยืนยัน identity ได้", {
            size: "xs", color: "#8A4B00", margin: "md"
          }),
          lineText("🧪 การสร้าง/เปิดแคมเปญยังเป็น DRY-RUN", {
            size: "xs", color: "#8A4B00", margin: "sm"
          }),
          lineText("ถ้าปุ่มคัดลอกใช้ไม่ได้ กด “วิธีใช้ / Template” ด้านล่าง", {
            size: "xs", color: "#777777", margin: "sm"
          })
        ]
      },
      footer: {
        type: "box", layout: "vertical", spacing: "sm", contents: [
          ...shortcutButtons,
          ...viewAllButton,
          { type: "button", style: "primary", color: "#06C755", action: clipboardAction("คัดลอก Template", template) }
        ]
      }
    },
    quickReply: helpQuickReply(alias)
  };
}

function campaignChoiceBubble({ client, snapshot, stale }, now, pageLabel) {
  const alias = primaryAlias(client);
  const source = snapshotSourceText(snapshot, now, stale);
  const freshAndActive = snapshot?.campaignStatus === "ACTIVE" && !stale;
  return {
    type: "bubble",
    header: {
      type: "box", layout: "vertical", backgroundColor: freshAndActive ? "#FFF4E5" : "#F3F4F6",
      contents: [lineText(`⏸️ ${client.name}`, { weight: "bold", size: "lg", color: freshAndActive ? "#8A4B00" : "#555555" })]
    },
    body: {
      type: "box", layout: "vertical", spacing: "sm", contents: [
        detailRow("Campaign", snapshot?.campaignName ?? "—"),
        detailRow("Ad account", accountSuffix(client.advertiserId)),
        detailRow("งบปัจจุบัน", formatMinor(snapshot?.dailyBudgetMinor, snapshot?.currency)),
        detailRow("ใช้ไป", formatMinor(snapshot?.costMinor, snapshot?.currency)),
        lineText(source, { size: "xs", color: stale ? "#B45309" : "#666666", margin: "md" }),
        lineText("แหล่งรายการ: ACTIVE campaign ล่าสุดจาก Chrome reader", {
          size: "xs", color: "#777777", margin: "sm"
        }),
        lineText("🧪 ปุ่มปิดจะเปิดหน้ายืนยัน DRY-RUN", {
          size: "xs", color: "#8A4B00", margin: "sm"
        }),
        lineText(pageLabel, { size: "xs", color: "#777777", margin: "sm", align: "end" })
      ]
    },
    footer: {
      type: "box", layout: "vertical", spacing: "sm", contents: [
        {
          type: "button",
          ...(freshAndActive ? { style: "primary", color: "#D14343" } : {}),
          action: freshAndActive
            ? messageAction("ปิดแคมเปญนี้", `พัก ${alias}`)
            : messageAction("รีเฟรชสถานะ", `สถานะ ${alias}`)
        },
        { type: "button", action: messageAction("กลับเมนู", "เมนู") }
      ]
    }
  };
}

export function buildCampaignPauseChoicesMessage({ entries = [], now = new Date(), page = 1 } = {}) {
  if (entries.length === 0) {
    return {
      type: "text",
      text: "ยังไม่พบแคมเปญ ACTIVE จาก Chrome reader ในบัญชีที่คุณมีสิทธิ์\nลองรีเฟรชหน้า TikTok หรือรอ API sync แล้วเปิดเมนูอีกครั้ง",
      quickReply: menuQuickReply()
    };
  }
  const pageCount = Math.max(1, Math.ceil(entries.length / CAROUSEL_PAGE_SIZE));
  const currentPage = Math.min(pageCount, Math.max(1, Number.isSafeInteger(page) ? page : 1));
  const visible = entries.slice(
    (currentPage - 1) * CAROUSEL_PAGE_SIZE,
    currentPage * CAROUSEL_PAGE_SIZE
  );
  const pageLabel = `หน้า ${currentPage}/${pageCount} · ทั้งหมด ${entries.length} แคมเปญ`;
  return {
    type: "flex",
    altText: `เลือกแคมเปญที่จะปิด · ${pageLabel}`,
    contents: {
      type: "carousel",
      contents: visible.map((entry) => campaignChoiceBubble(entry, now, pageLabel))
    },
    quickReply: paginationQuickReply({
      page: currentPage,
      pageCount,
      previousText: `ปิดแคมเปญ หน้า ${currentPage - 1}`,
      nextText: `ปิดแคมเปญ หน้า ${currentPage + 1}`
    })
  };
}

export function buildCampaignAdjustmentMessage({ client, snapshot, stale = false, now = new Date() } = {}) {
  if (!client) throw new TypeError("client is required");
  const alias = primaryAlias(client);
  if (!snapshot) {
    return {
      type: "text",
      text: `⚠️ ${client.name}: ยังไม่มีข้อมูลแคมเปญจาก Chrome reader จึงยังสร้างคำสั่งปรับไม่ได้`,
      quickReply: {
        items: [
          { type: "action", action: messageAction("ดูสถานะ", `สถานะ ${alias}`) },
          { type: "action", action: messageAction("เมนู", "เมนู") }
        ]
      }
    };
  }
  const body = [
    detailRow("Campaign", snapshot.campaignName),
    detailRow("Ad account", accountSuffix(client.advertiserId)),
    detailRow("TikTok account", accountSuffix(client.campaignSelector?.expectedTikTokAccountId)),
    detailRow("งบปัจจุบัน", formatMinor(snapshot.dailyBudgetMinor, snapshot.currency)),
    detailRow("ชื่อ Ad", "รอ TikTok API"),
    detailRow("ชื่อช่อง", "รอ TikTok API"),
    lineText(snapshotSourceText(snapshot, now, stale), {
      size: "xs", color: stale ? "#B45309" : "#666666", margin: "md"
    }),
    lineText("🧪 คำสั่งปรับงบ/ROI ยังเป็น DRY-RUN", {
      size: "xs", color: "#8A4B00", margin: "sm"
    }),
    lineText("ถ้าปุ่มคัดลอกใช้ไม่ได้ กด “วิธีใช้ / Template”", {
      size: "xs", color: "#777777", margin: "sm"
    })
  ];
  if (stale) {
    body.push(lineText("ระบบซ่อน Template ปรับงบจนกว่าจะได้ข้อมูลล่าสุด", {
      size: "xs", color: "#B45309", margin: "sm"
    }));
  }
  const controls = stale
    ? [{ type: "button", style: "primary", color: "#06C755", action: messageAction("รีเฟรชสถานะ", `สถานะ ${alias}`) }]
    : [
        { type: "button", style: "primary", color: "#06C755", action: clipboardAction("เพิ่มงบ Template", `เพิ่มงบ ${alias} 500`) },
        { type: "button", action: clipboardAction("ลดงบ Template", `ลดงบ ${alias} 500`) },
        { type: "button", action: clipboardAction("ตั้งงบ Template", `ตั้งงบ ${alias} ${plainMajor(snapshot.dailyBudgetMinor)}`) },
        { type: "button", action: clipboardAction("ตั้ง ROI Template", `ตั้ง ROI ${alias} 3.5`) }
      ];
  return {
    type: "flex",
    altText: `ปรับข้อมูลแคมเปญ · ${client.name}`,
    contents: {
      type: "bubble",
      header: {
        type: "box", layout: "vertical", backgroundColor: stale ? "#F3F4F6" : "#EAF7F0",
        contents: [lineText(`🛠️ ปรับเพิ่ม / ลด — ${client.name}`, { weight: "bold", size: "lg" })]
      },
      body: { type: "box", layout: "vertical", spacing: "sm", contents: body },
      footer: {
        type: "box", layout: "vertical", spacing: "sm", contents: [
          ...controls
        ]
      }
    },
    quickReply: helpQuickReply(alias)
  };
}

function performanceBubble({ client, snapshot, stale }, now, pageLabel) {
  if (!snapshot) {
    return {
      type: "bubble",
      header: {
        type: "box", layout: "vertical", backgroundColor: "#F3F4F6",
        contents: [lineText(`⚠️ ${client.name}`, { weight: "bold", size: "lg", color: "#555555" })]
      },
      body: {
        type: "box", layout: "vertical", spacing: "sm", contents: [
          lineText("ยังไม่มี snapshot จาก Chrome reader", { size: "sm", color: "#555555" }),
          lineText(pageLabel, { size: "xs", color: "#777777", margin: "md", align: "end" })
        ]
      },
      footer: {
        type: "box", layout: "vertical", contents: [
          { type: "button", action: messageAction("เมนูหลัก", "เมนู") }
        ]
      }
    };
  }
  const usage = snapshot.dailyBudgetMinor > 0
    ? `${((snapshot.costMinor / snapshot.dailyBudgetMinor) * 100).toFixed(1)}%`
    : "—";
  return {
    type: "bubble",
    header: {
      type: "box", layout: "vertical", backgroundColor: stale ? "#FFF4E5" : "#EAF7F0",
      contents: [lineText(`${stale ? "⚠️" : "📊"} ${client.name}`, {
        weight: "bold", size: "lg", color: stale ? "#8A4B00" : "#135C3B"
      })]
    },
    body: {
      type: "box", layout: "vertical", spacing: "sm", contents: [
        detailRow("Campaign", snapshot.campaignName),
        detailRow("สถานะ", snapshot.campaignStatus ?? "—"),
        detailRow("งบ", formatMinor(snapshot.dailyBudgetMinor, snapshot.currency)),
        detailRow("ใช้ไป", `${formatMinor(snapshot.costMinor, snapshot.currency)} (${usage})`),
        detailRow("ยอดขาย Gross", formatMinor(snapshot.grossRevenueMinor, snapshot.currency)),
        detailRow("Gross ROI", formatRoiMilli(snapshot.grossRoiMilli)),
        detailRow("ยอดขาย Net", formatMinor(snapshot.netRevenueMinor, snapshot.currency)),
        detailRow("Net ROI", formatRoiMilli(snapshot.netRoiMilli)),
        detailRow("GMV", formatMinor(snapshot.gmvMinor, snapshot.currency)),
        lineText(snapshotSourceText(snapshot, now, stale), {
          size: "xs", color: stale ? "#B45309" : "#666666", margin: "md"
        }),
        ...(snapshot.schemaVersion === 1
          ? [lineText("Reader รุ่นเดิมยังไม่มียอดขายและ ROI กรุณาโหลด Extension รุ่นใหม่", {
              size: "xs", color: "#B45309"
            })]
          : []),
        ...(stale
          ? [lineText("ไม่ใช้ข้อมูลชุดนี้ตัดสินใจแก้แคมเปญ", { size: "xs", color: "#B45309" })]
          : []),
        lineText(`แหล่ง: snapshot ล่าสุดที่ระบบได้รับ · 1 ${snapshot.campaignStatus ?? "unknown"} campaign/บัญชี`, {
          size: "xs", color: "#777777", margin: "sm"
        }),
        lineText(pageLabel, { size: "xs", color: "#777777", margin: "sm", align: "end" })
      ]
    },
    footer: {
      type: "box", layout: "vertical", spacing: "sm", contents: [
        { type: "button", action: messageAction("ปรับบัญชีนี้", `ปรับข้อมูล ${primaryAlias(client)}`) },
        { type: "button", action: messageAction("เมนูหลัก", "เมนู") }
      ]
    }
  };
}

export function buildAgencyPerformanceReportMessage({ entries = [], now = new Date(), page = 1 } = {}) {
  if (entries.length === 0) {
    return { type: "text", text: "ยังไม่มีบัญชีสำหรับออกรายงาน", quickReply: menuQuickReply() };
  }
  const pageCount = Math.max(1, Math.ceil(entries.length / CAROUSEL_PAGE_SIZE));
  const currentPage = Math.min(pageCount, Math.max(1, Number.isSafeInteger(page) ? page : 1));
  const visible = entries.slice(
    (currentPage - 1) * CAROUSEL_PAGE_SIZE,
    currentPage * CAROUSEL_PAGE_SIZE
  );
  const pageLabel = `หน้า ${currentPage}/${pageCount} · ทั้งหมด ${entries.length} บัญชี`;
  return {
    type: "flex",
    altText: `Report ล่าสุด · ${pageLabel}`,
    contents: {
      type: "carousel",
      contents: visible.map((entry) => performanceBubble(entry, now, pageLabel))
    },
    quickReply: paginationQuickReply({
      page: currentPage,
      pageCount,
      previousText: `อัปเดต Report ล่าสุด หน้า ${currentPage - 1}`,
      nextText: `อัปเดต Report ล่าสุด หน้า ${currentPage + 1}`
    })
  };
}

export function buildAutoBoostSetupTemplateMessage({ client, snapshot, stale = false, now = new Date() } = {}) {
  if (!client) throw new TypeError("client is required");
  const alias = primaryAlias(client);
  const baseBudgetMinor = snapshot && !stale ? snapshot.dailyBudgetMinor : defaultBudgetMinor(client);
  const template = autoBoostTemplateText(client, { baseBudgetMinor });
  return {
    type: "flex",
    altText: `ตั้ง Auto Boost · ${client.name}`,
    contents: {
      type: "bubble",
      header: {
        type: "box", layout: "vertical", backgroundColor: "#EEF2FF",
        contents: [lineText(`⚡ ตั้ง Auto Boost — ${client.name}`, { weight: "bold", size: "lg", color: "#3730A3" })]
      },
      body: {
        type: "box", layout: "vertical", spacing: "sm", contents: [
          detailRow("งบฐานแนะนำ", formatMinor(baseBudgetMinor, snapshot?.currency ?? client.campaignSelector?.currency)),
          detailRow("เพิ่ม", `${client.lineControl?.autoBoost?.boostPercent ?? 10}%`),
          detailRow("เริ่มก่อน", `${client.lineControl?.autoBoost?.leadMinutes ?? 10} นาที`),
          ...(snapshot ? [detailRow("Campaign", snapshot.campaignName)] : []),
          lineText(snapshotSourceText(snapshot, now, stale), {
            size: "xs", color: stale ? "#B45309" : "#666666", margin: "md"
          }),
          lineText("กดคัดลอก แก้งบฐานและช่วงเวลา แล้วส่งกลับมาทั้งข้อความ", {
            size: "sm", color: "#555555", margin: "md"
          }),
          lineText("🧪 Auto Boost ยังแจ้งเหตุการณ์แบบ DRY-RUN และไม่แก้ TikTok", {
            size: "xs", color: "#8A4B00", margin: "sm"
          }),
          lineText("ถ้าปุ่มคัดลอกใช้ไม่ได้ กด “วิธีใช้ / Template”", {
            size: "xs", color: "#777777", margin: "sm"
          })
        ]
      },
      footer: {
        type: "box", layout: "vertical", spacing: "sm", contents: [
          { type: "button", style: "primary", color: "#06C755", action: clipboardAction("คัดลอก Template", template) }
        ]
      }
    },
    quickReply: helpQuickReply(alias)
  };
}

export function buildControlMenuMessage(client) {
  const alias = client.lineControl?.aliases?.[0] ?? client.name;
  const currency = client.campaignSelector?.currency ?? "THB";
  return {
    type: "flex",
    altText: `เมนูควบคุมโฆษณา ${client.name}`,
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#EAF7F0",
        contents: [lineText(`🐋 ${client.name}`, { weight: "bold", size: "lg", color: "#135C3B" })]
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          detailRow("Ad account", accountSuffix(client.advertiserId)),
          detailRow("เพดานงบ", formatMinor(Math.round(client.budgetPolicy.maxDailyBudget * 100), currency)),
          lineText("คำสั่งที่เขียน TikTok ยังเป็น DRY-RUN ระหว่างรอเชื่อม API", {
            size: "xs", color: "#8A4B00", margin: "md"
          })
        ]
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          { type: "button", style: "primary", color: "#06C755", action: { type: "message", label: "สถานะตอนนี้", text: `สถานะ ${alias}` } },
          { type: "button", action: { type: "message", label: "ดู Shortcut", text: `ดู shortcut ${alias}` } },
          { type: "button", action: { type: "message", label: "Auto Boost", text: `ดู Auto Boost ${alias}` } },
          { type: "button", action: { type: "message", label: "ตัวอย่างคำสั่ง", text: `วิธีใช้ ${alias}` } }
        ]
      }
    }
  };
}

function autoBoostWindowText(windows) {
  if (!Array.isArray(windows) || windows.length === 0) return "ยังไม่ได้ตั้งเวลา";
  return windows.map((window) => `${window.start}-${window.end}`).join("\n");
}

/** Build the LINE Flex status card; LINE message buttons act as the ON/OFF toggle. */
export function buildAutoBoostStatusMessage(input) {
  const client = input?.client;
  const profile = input?.plan ?? input?.profile;
  if (!client || !profile) throw new TypeError("client and Auto Boost plan are required");
  const alias = client.lineControl?.aliases?.[0] ?? client.name;
  const enabled = profile.enabled === true;
  const isDryRun = profile.executionMode !== "LIVE";
  const boostBps = profile.boostBps ?? Math.round(Number(profile.boostPercent ?? 0) * 100);
  const currency = client.campaignSelector?.currency ?? "THB";
  const originalWindows = profile.originalWindows ?? profile.windows ?? [];
  const targetBudgetMinor = profile.targetBudgetMinor;
  const nextAction = input.nextAction ?? profile.nextAction;
  const restoreDraining = !enabled
    && nextAction?.phase === "RESTORE"
    && new Set(["PENDING", "PROCESSING"]).has(nextAction?.status);
  const rows = [
    detailRow("สถานะ", enabled ? "🟢 เปิด" : "⚪ ปิด"),
    detailRow("Ad account", accountSuffix(client.advertiserId)),
    detailRow("งบฐาน", formatMinor(profile.baseBudgetMinor, currency)),
    detailRow("งบช่วงพิเศษ", formatMinor(targetBudgetMinor, currency)),
    detailRow("เพิ่ม", Number.isSafeInteger(boostBps) ? `${boostBps / 100}%` : "—"),
    detailRow("เริ่มก่อน", `${profile.leadMinutes} นาที`),
    lineText("ช่วงเวลาประจำวัน", { size: "sm", color: "#777777", margin: "md" }),
    lineText(autoBoostWindowText(originalWindows), { size: "sm", color: "#111111" })
  ];
  if (nextAction?.dueAt) {
    rows.push(detailRow(
      nextAction.phase === "RESTORE" ? "คืนงบครั้งถัดไป" : "เพิ่มงบครั้งถัดไป",
      bangkokTime(nextAction.dueAt)
    ));
  }
  rows.push(lineText(
    isDryRun
      ? "🧪 DRY-RUN: ระบบจะแจ้งเหตุการณ์ตามเวลา แต่ยังไม่เปลี่ยนงบใน TikTok"
      : "ระบบจะตรวจงบและบัญชีล่าสุดก่อนเปลี่ยนทุกครั้ง",
    { size: "xs", color: isDryRun ? "#8A4B00" : "#666666", margin: "md" }
  ));
  rows.push(lineText("ถ้าปุ่มคัดลอกใช้ไม่ได้ กด “วิธีใช้ / Template” ด้านล่าง", {
    size: "xs", color: "#777777", margin: "sm"
  }));

  const toggleText = `${enabled ? "ปิด" : "เปิด"} Auto Boost ${alias}`;
  const editTemplate = autoBoostTemplateText(client, {
    baseBudgetMinor: profile.baseBudgetMinor,
    boostBps,
    leadMinutes: profile.leadMinutes,
    windows: originalWindows
  });
  return {
    type: "flex",
    altText: `Auto Boost ${client.name}: ${enabled ? "ON" : "OFF"}${isDryRun ? " (DRY-RUN)" : ""}`,
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: enabled ? "#EAF7F0" : "#F3F4F6",
        contents: [lineText(`⚡ Auto Boost — ${client.name}`, {
          weight: "bold", size: "lg", color: enabled ? "#135C3B" : "#555555"
        })]
      },
      body: { type: "box", layout: "vertical", spacing: "sm", contents: rows },
      footer: {
        type: "box", layout: "vertical", spacing: "sm", contents: [
          {
            type: "button",
            style: restoreDraining ? "secondary" : "primary",
            ...(restoreDraining ? {} : { color: enabled ? "#D14343" : "#06C755" }),
            action: restoreDraining
              ? { type: "message", label: "กำลังรอคืนงบ", text: `ดู Auto Boost ${alias}` }
              : { type: "message", label: enabled ? "ปิด Auto Boost" : "เปิด Auto Boost", text: toggleText }
          },
          {
            type: "button",
            action: { type: "message", label: "ดูสถานะอีกครั้ง", text: `ดู Auto Boost ${alias}` }
          },
          {
            type: "button",
            action: clipboardAction("คัดลอกตารางเพื่อแก้", editTemplate)
          },
          {
            type: "button",
            action: messageAction("กลับเมนู", "เมนู")
          }
        ]
      }
    },
    quickReply: helpQuickReply(alias)
  };
}

/** Build the notification for one scheduled occurrence while writes remain disabled. */
export function buildAutoBoostDryRunOccurrenceMessage(input) {
  const client = input?.client;
  const profile = input?.plan ?? input?.profile;
  const occurrence = input?.occurrence;
  if (!client || !profile || !occurrence) {
    throw new TypeError("client, Auto Boost plan, and occurrence are required");
  }
  const restore = occurrence.phase === "RESTORE";
  if (!restore && occurrence.phase !== "BOOST") {
    throw new RangeError("Auto Boost occurrence phase must be BOOST or RESTORE");
  }
  const fromMinor = restore ? profile.targetBudgetMinor : profile.baseBudgetMinor;
  const toMinor = restore ? profile.baseBudgetMinor : profile.targetBudgetMinor;
  const currency = client.campaignSelector?.currency ?? "THB";
  return {
    type: "text",
    text: [
      `🧪 DRY-RUN ${restore ? "คืนงบ Auto Boost" : "Auto Boost"} — ${client.name}`,
      `Ad account: ${accountSuffix(client.advertiserId)}`,
      `งบ: ${formatMinor(fromMinor, currency)} → ${formatMinor(toMinor, currency)}`,
      `เวลาจำลอง: ${bangkokTime(occurrence.dueAt)}`,
      "ระบบยังไม่ได้เปลี่ยนงบใน TikTok"
    ].join("\n")
  };
}

export function buildAutoBoostOccurrenceMessage(input) {
  return buildAutoBoostDryRunOccurrenceMessage(input);
}

export function buildPerformanceReportMessage({ client, snapshot, now = new Date(), stale = false }) {
  if (!snapshot) {
    return { type: "text", text: `⚠️ ${client.name}: ยังไม่มีข้อมูลจาก Chrome reader จึงยังรายงานไม่ได้` };
  }
  const usage = snapshot.dailyBudgetMinor > 0
    ? `${((snapshot.costMinor / snapshot.dailyBudgetMinor) * 100).toFixed(1)}%`
    : "—";
  const ageMinutes = Math.max(0, Math.floor((new Date(now).getTime() - Date.parse(snapshot.observedAt)) / 60_000));
  const lines = [
    `${stale ? "⚠️ ข้อมูลเก่า" : "📊 สถานะ LIVE GMV Max"} — ${client.name}`,
    `Campaign: ${snapshot.campaignName}`,
    `งบปัจจุบัน: ${formatMinor(snapshot.dailyBudgetMinor, snapshot.currency)}`,
    `ใช้ไป: ${formatMinor(snapshot.costMinor, snapshot.currency)} (${usage})`,
    `ยอดขาย Gross: ${formatMinor(snapshot.grossRevenueMinor, snapshot.currency)}`,
    `Gross ROI: ${formatRoiMilli(snapshot.grossRoiMilli)}`,
    `ยอดขาย Net: ${formatMinor(snapshot.netRevenueMinor, snapshot.currency)}`,
    `Net ROI: ${formatRoiMilli(snapshot.netRoiMilli)}`,
    `GMV: ${formatMinor(snapshot.gmvMinor, snapshot.currency)}`,
    `ข้อมูลจาก Chrome เวลา ${bangkokTime(snapshot.observedAt)} (${ageMinutes} นาทีที่แล้ว)`
  ];
  if (snapshot.schemaVersion === 1) lines.push("ℹ️ Reader รุ่นเดิมยังไม่มีข้อมูลยอดขายและ ROI กรุณาโหลด Extension รุ่นใหม่");
  if (stale) lines.push("ระบบจะไม่ใช้ข้อมูลชุดนี้ตัดสินใจเปลี่ยนแปลงแคมเปญ");
  return { type: "text", text: lines.join("\n") };
}

export function buildShortcutListMessage({ client, shortcuts }) {
  const currency = client.campaignSelector?.currency ?? "THB";
  if (shortcuts.length === 0) {
    const alias = client.lineControl?.aliases?.[0] ?? client.name;
    return {
      type: "text",
      text: [
        `ยังไม่มี Shortcut ของ ${client.name}`,
        "สร้างด้วยข้อความ 5 บรรทัด:",
        `ตั้ง shortcut ${alias} main`,
        "ชื่อ {date} {start}:00",
        "งบ 3000",
        "ROI 3.5",
        "เติมเมื่อ 80%"
      ].join("\n")
    };
  }
  const lines = [`📌 Shortcut — ${client.name}`];
  let visibleCount = 0;
  for (const shortcut of shortcuts.slice(0, 20)) {
    const block = [
      `\n${shortcut.shortcutName} (rev ${shortcut.revision})`,
      `ชื่อ: ${shortcut.campaignNameTemplate}`,
      `งบ: ${formatMinor(shortcut.dailyBudgetMinor, currency)}`,
      `Target ROI: ${formatRoiMilli(shortcut.targetRoiMilli)}`,
      `เกณฑ์เติมงบที่บันทึก (ทดลอง): ${(shortcut.topUpThresholdBps / 100).toFixed(0)}%`
    ];
    if ([...lines, ...block].join("\n").length > 4_500) break;
    lines.push(...block);
    visibleCount += 1;
  }
  if (shortcuts.length > visibleCount) {
    lines.push(`\n…และอีก ${shortcuts.length - visibleCount} Shortcut`);
  }
  return { type: "text", text: lines.join("\n") };
}

const ACTION_LABELS = Object.freeze({
  CREATE_FROM_SHORTCUT: "สร้างและเปิดแคมเปญ",
  UPDATE_BUDGET: "เปลี่ยนงบรายวัน",
  ADJUST_BUDGET: "ปรับเพิ่ม/ลดงบรายวัน",
  UPDATE_ROI: "เปลี่ยน Target ROI",
  PAUSE: "พักแคมเปญ",
  RESUME: "เปิดแคมเปญอีกครั้ง",
  SCHEDULE_COUPON_BOOST: "ตั้ง Coupon Boost"
});

export function buildControlConfirmationMessage(request) {
  const desired = request.data.desired ?? {};
  const before = request.data.before ?? {};
  const currency = request.data.currency ?? "THB";
  const rows = [
    detailRow("ลูกค้า", request.data.clientName),
    detailRow("Ad account", accountSuffix(request.data.advertiserId)),
    detailRow("คำสั่ง", ACTION_LABELS[request.action] ?? request.action)
  ];
  if (before.campaignName) rows.push(detailRow("Campaign", before.campaignName));
  if (desired.campaignName) rows.push(detailRow("ชื่อใหม่", desired.campaignName));
  if (Number.isSafeInteger(before.dailyBudgetMinor)) rows.push(detailRow("งบเดิม", formatMinor(before.dailyBudgetMinor, currency)));
  if (Number.isSafeInteger(desired.budgetDeltaMinor)) {
    const direction = desired.budgetDeltaMinor >= 0 ? "+" : "−";
    rows.push(detailRow("ปรับงบ", `${direction}${formatMinor(Math.abs(desired.budgetDeltaMinor), currency)}`));
  }
  if (Number.isSafeInteger(desired.dailyBudgetMinor)) rows.push(detailRow("งบเป้าหมาย", formatMinor(desired.dailyBudgetMinor, currency)));
  if (Number.isSafeInteger(desired.targetRoiMilli)) rows.push(detailRow("Target ROI", formatRoiMilli(desired.targetRoiMilli)));
  if (Number.isSafeInteger(desired.topUpThresholdBps)) {
    rows.push(detailRow("เกณฑ์เติม (ทดลอง)", `${desired.topUpThresholdBps / 100}%`));
  }
  if (desired.eventAt) rows.push(detailRow("เวลาคูปอง", bangkokTime(desired.eventAt)));
  if (desired.notifyAt) rows.push(detailRow("เริ่มเตือน", bangkokTime(desired.notifyAt)));
  rows.push(lineText(
    request.data.dryRun
      ? "🧪 DRY-RUN: ยืนยันแล้วระบบจะบันทึกการทดสอบ แต่ยังไม่เปลี่ยน TikTok"
      : "ระบบจะอ่านบัญชีและสถานะล่าสุดซ้ำก่อนดำเนินการ",
    { size: "xs", color: request.data.dryRun ? "#8A4B00" : "#666666", margin: "md" }
  ));
  return {
    type: "flex",
    altText: `${request.data.dryRun ? "ทดสอบ " : ""}${ACTION_LABELS[request.action] ?? "คำสั่งแคมเปญ"}`,
    contents: {
      type: "bubble",
      header: {
        type: "box", layout: "vertical", backgroundColor: "#FFF4E5",
        contents: [lineText(`${request.data.dryRun ? "🧪 " : ""}${ACTION_LABELS[request.action] ?? request.action}`, {
          weight: "bold", size: "lg", color: "#8A4B00"
        })]
      },
      body: { type: "box", layout: "vertical", spacing: "sm", contents: rows },
      footer: {
        type: "box", layout: "vertical", spacing: "sm", contents: [
          {
            type: "button", style: "primary", color: "#06C755",
            action: {
              type: "postback", label: request.data.dryRun ? "ยืนยันทดสอบ" : "ยืนยันคำสั่ง",
              data: `op=confirm&id=${request.id}&v=${request.version}`,
              displayText: request.data.dryRun ? "ยืนยันทดสอบ" : "ยืนยันคำสั่ง"
            }
          },
          {
            type: "button",
            action: { type: "postback", label: "ยกเลิก", data: `op=reject&id=${request.id}&v=${request.version}`, displayText: "ยกเลิก" }
          }
        ]
      }
    }
  };
}

export function buildCouponReminderMessage({ clientName, eventAt, budgetMinor, request }) {
  return [
    {
      type: "text",
      text: [
        `🎟️ ใกล้ถึงเวลาคูปอง — ${clientName}`,
        `เวลาคูปอง: ${bangkokTime(eventAt)}`,
        `งบพิเศษที่เตรียมไว้: ${formatMinor(budgetMinor, request?.data?.currency ?? "THB")}`,
        "โปรดตรวจ LIVE และใช้ปุ่มยืนยันด้านล่าง"
      ].join("\n")
    },
    buildControlConfirmationMessage(request)
  ];
}

export function controlHelpText(client) {
  const alias = client.lineControl?.aliases?.[0] ?? client.name;
  return [
    `วิธีใช้ ${client.name}`,
    "• เมนู (เปิด Command Center)",
    `• สถานะ ${alias}`,
    `• รายงาน ${alias} ทุก 2 ชั่วโมง`,
    `• หยุดรายงาน ${alias}`,
    `• ดู shortcut ${alias}`,
    `• เปิด ${alias} main`,
    `• ตั้งงบ ${alias} 2500`,
    `• เพิ่มงบ ${alias} 500 / ลดงบ ${alias} 500`,
    `• ตั้ง ROI ${alias} 3.5`,
    `• พัก ${alias} / เปิดใหม่ ${alias}`,
    `• คูปอง ${alias} 2026-07-21 20:00 ก่อน 30 นาที งบ 5000`,
    `• ดู Auto Boost ${alias}`,
    `• เปิด Auto Boost ${alias} / ปิด Auto Boost ${alias}`,
    "",
    "สร้างหรือแก้ Shortcut (ส่ง 5 บรรทัด):",
    `ตั้ง shortcut ${alias} main`,
    "ชื่อ {date} {start}:00",
    "งบ 3000",
    "ROI 3.5",
    "เติมเมื่อ 80%",
    "",
    "ตั้ง Auto Boost (ส่งทุกช่วงเวลาในข้อความเดียว):",
    `ตั้ง Auto Boost ${alias}`,
    "งบฐาน 3000",
    "เพิ่ม 10%",
    "ก่อน 10 นาที",
    "ช่วงเวลา",
    "12:00-13:00",
    "15:00-16:00",
    "20:00-21:00"
  ].join("\n");
}
