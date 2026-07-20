import crypto from "node:crypto";

const CONTROL_REQUEST_ID = /^ca_[A-Za-z0-9-]{16,80}$/;
const SHORTCUT_NAME = /^[A-Za-z0-9ก-๙_-]{1,32}$/u;
const CLIENT_ALIAS = /^[A-Za-z0-9ก-๙_.-]{1,80}$/u;

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

/**
 * Exact, bounded LINE commands for campaign operations. Advertiser, BC, Shop,
 * and TikTok account identities are deliberately never accepted from chat.
 */
export function parseControlCommand(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > 800) return null;
  const value = cleanText(text);
  const shortcut = parseShortcutDefinition(text);
  if (shortcut) return shortcut;

  let match = value.match(/^(?:เมนู|menu)\s+(\S+)$/iu);
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
  match = value.match(/^(?:ตั้งงบ|งบใหม่|เพิ่มงบ|ลดงบ)\s+(\S+)\s+(.+)$/u);
  if (match) {
    const clientAlias = commandClientAlias(match[1]);
    const amount = parseAmount(match[2]);
    return clientAlias && amount !== null
      ? { kind: "action", action: "UPDATE_BUDGET", clientAlias, amount }
      : null;
  }
  match = value.match(/^ตั้ง\s*ROI\s+(\S+)\s+(.+)$/iu);
  if (match) {
    const clientAlias = commandClientAlias(match[1]);
    const targetRoi = parseRoi(match[2]);
    return clientAlias && targetRoi !== null
      ? { kind: "action", action: "UPDATE_ROI", clientAlias, targetRoi }
      : null;
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
  return id.length <= 4 ? id : `••••${id.slice(-4)}`;
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

export function buildControlMenuMessage(client) {
  const alias = client.lineControl?.aliases?.[0] ?? client.name;
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
          detailRow("เพดานงบ", formatMinor(Math.round(client.budgetPolicy.maxDailyBudget * 100))),
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
          { type: "button", action: { type: "message", label: "ตัวอย่างคำสั่ง", text: `วิธีใช้ ${alias}` } }
        ]
      }
    }
  };
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
      `งบ: ${formatMinor(shortcut.dailyBudgetMinor)}`,
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
  UPDATE_ROI: "เปลี่ยน Target ROI",
  PAUSE: "พักแคมเปญ",
  RESUME: "เปิดแคมเปญอีกครั้ง",
  SCHEDULE_COUPON_BOOST: "ตั้ง Coupon Boost"
});

export function buildControlConfirmationMessage(request) {
  const desired = request.data.desired ?? {};
  const before = request.data.before ?? {};
  const rows = [
    detailRow("ลูกค้า", request.data.clientName),
    detailRow("Ad account", accountSuffix(request.data.advertiserId)),
    detailRow("คำสั่ง", ACTION_LABELS[request.action] ?? request.action)
  ];
  if (before.campaignName) rows.push(detailRow("Campaign", before.campaignName));
  if (desired.campaignName) rows.push(detailRow("ชื่อใหม่", desired.campaignName));
  if (Number.isSafeInteger(before.dailyBudgetMinor)) rows.push(detailRow("งบเดิม", formatMinor(before.dailyBudgetMinor)));
  if (Number.isSafeInteger(desired.dailyBudgetMinor)) rows.push(detailRow("งบเป้าหมาย", formatMinor(desired.dailyBudgetMinor)));
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
        `งบพิเศษที่เตรียมไว้: ${formatMinor(budgetMinor)}`,
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
    `• สถานะ ${alias}`,
    `• รายงาน ${alias} ทุก 2 ชั่วโมง`,
    `• หยุดรายงาน ${alias}`,
    `• ดู shortcut ${alias}`,
    `• เปิด ${alias} main`,
    `• ตั้งงบ ${alias} 2500`,
    `• ตั้ง ROI ${alias} 3.5`,
    `• พัก ${alias} / เปิดใหม่ ${alias}`,
    `• คูปอง ${alias} 2026-07-21 20:00 ก่อน 30 นาที งบ 5000`,
    "",
    "สร้างหรือแก้ Shortcut (ส่ง 5 บรรทัด):",
    `ตั้ง shortcut ${alias} main`,
    "ชื่อ {date} {start}:00",
    "งบ 3000",
    "ROI 3.5",
    "เติมเมื่อ 80%"
  ].join("\n");
}
