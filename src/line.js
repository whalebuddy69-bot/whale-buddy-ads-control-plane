import crypto from "node:crypto";

const LINE_API_BASE = "https://api.line.me/v2/bot/message";

export function verifyLineSignature(rawBody, signature, channelSecret) {
  if (!Buffer.isBuffer(rawBody)) rawBody = Buffer.from(rawBody ?? "");
  if (typeof signature !== "string" || typeof channelSecret !== "string" || channelSecret === "") return false;
  const expected = crypto.createHmac("sha256", channelSecret).update(rawBody).digest("base64");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

export function parsePostbackData(data) {
  if (typeof data !== "string" || data.length === 0 || data.length > 300) return null;
  const params = new URLSearchParams(data);
  const action = params.get("a");
  const requestId = params.get("id");
  if (!new Set(["suggest", "confirm", "custom", "reject"]).has(action)) return null;
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(requestId ?? "")) return null;
  const rawVersion = params.get("v");
  const version = rawVersion == null ? null : Number(rawVersion);
  if (action === "confirm" && (!Number.isSafeInteger(version) || version < 1)) return null;
  return { action, requestId, version };
}

export function parseBudgetText(text) {
  if (typeof text !== "string") return null;
  const normalized = text.trim().replace(/[฿,]/g, "");
  const match = normalized.match(/^(?:งบ|budget)\s+([a-zA-Z0-9]{12})\s+(\d+(?:\.\d{1,2})?)$/i);
  if (!match) return null;
  const amount = Number(match[2]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return { requestCode: match[1].toLowerCase(), amount };
}

export function parsePairingText(text) {
  if (typeof text !== "string") return null;
  const normalized = text.trim();
  const match = normalized.match(/^(?:จับคู่|pair)\s+([A-Za-z0-9_-]{2,80})\s+([A-Za-z0-9_-]{16,64})$/i);
  if (!match) return null;
  return { clientId: match[1], code: match[2] };
}

export function requestCodeFor(requestId) {
  const code = String(requestId ?? "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 12).toLowerCase();
  if (!/^[a-z0-9]{12}$/.test(code)) throw new Error("request ID cannot produce a safe 12-character code");
  return code;
}

export function formatMoney(value, currency) {
  return new Intl.NumberFormat("th-TH", {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  }).format(value);
}

function accountSuffix(advertiserId) {
  const id = String(advertiserId);
  return id.length <= 4 ? id : `••••${id.slice(-4)}`;
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
      lineText(label, { size: "sm", color: "#777777", flex: 4 }),
      lineText(value, { size: "sm", color: "#111111", flex: 7, align: "end" })
    ]
  };
}

export function buildBudgetAlertMessage(request) {
  const code = request.shortCode ?? requestCodeFor(request.id);
  const manualExampleBudget = request.manualExampleBudget ?? request.maxBudget ?? request.proposedBudget;
  const presetLabel = request.presetLabel ?? "ใช้งบแนะนำ";
  const allowManualTarget = request.allowManualTarget !== false;
  const dryRun = request.telemetryOnly === true || request.dryRun === true;
  const expires = new Date(request.expiresAt).toLocaleTimeString("th-TH", {
    timeZone: request.timezone ?? "Asia/Bangkok",
    hour: "2-digit",
    minute: "2-digit"
  });
  const utilization = request.spend != null && request.currentBudget > 0
    ? `${Math.round((request.spend / request.currentBudget) * 100)}%`
    : "—";

  const bodyContents = [
    ...(dryRun ? [lineText("🧪 ทดสอบการอนุมัติเท่านั้น — ไม่มีการเปลี่ยนงบจริงบน TikTok", {
      size: "sm",
      weight: "bold",
      color: "#8A4B00"
    })] : []),
    detailRow("Campaign", request.campaignName),
    detailRow("Ad account", accountSuffix(request.advertiserId)),
    detailRow("ใช้ไป", request.spend == null ? "รอข้อมูล" : formatMoney(request.spend, request.currency)),
    detailRow("งบปัจจุบัน", formatMoney(request.currentBudget, request.currency)),
    detailRow("การใช้งบ", utilization),
    detailRow("งบที่แนะนำ", formatMoney(request.proposedBudget, request.currency)),
    detailRow("หมดอายุ", expires)
  ];
  if (allowManualTarget) {
    bodyContents.push(lineText(`หากต้องการระบุเอง กด “กรอกงบเอง” แล้วส่ง: งบ ${code} ${manualExampleBudget}`, {
      size: "xs",
      color: "#777777",
      margin: "md"
    }));
  }

  const footerContents = [
    {
      type: "button",
      style: "primary",
      color: "#06C755",
      action: { type: "postback", label: presetLabel, data: `a=suggest&id=${request.id}`, displayText: presetLabel }
    }
  ];
  if (allowManualTarget) {
    footerContents.push({
      type: "button",
      action: { type: "postback", label: "กรอกงบเอง", data: `a=custom&id=${request.id}`, displayText: "กรอกงบเอง" }
    });
  }
  footerContents.push({
    type: "button",
    style: "secondary",
    action: { type: "postback", label: "ไม่เพิ่ม", data: `a=reject&id=${request.id}`, displayText: "ไม่เพิ่มงบ" }
  });

  return {
    type: "flex",
    altText: `${dryRun ? "ทดสอบ — " : ""}LIVE GMV Max ใกล้เต็มงบ: ${request.clientName}`,
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#FFF4E5",
        contents: [
          lineText(dryRun ? "🧪 DRY-RUN: LIVE GMV Max ใกล้เต็มงบ" : "⚠️ LIVE GMV Max ใกล้เต็มงบ", { weight: "bold", size: "lg", color: "#8A4B00" }),
          lineText(request.clientName, { size: "sm", color: "#8A4B00", margin: "sm" })
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: bodyContents
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: footerContents
      }
    }
  };
}

export function buildBudgetConfirmationMessage(request) {
  const dryRun = request.telemetryOnly === true || request.dryRun === true;
  return {
    type: "flex",
    altText: `${dryRun ? "ทดสอบ " : ""}ยืนยันงบใหม่ ${request.clientName}`,
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#EAF4FF",
        contents: [lineText(dryRun ? "ยืนยันการทดสอบ (ไม่แก้งบจริง)" : "ยืนยันการเพิ่มงบ", { weight: "bold", size: "lg", color: "#0B4F8A" })]
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          detailRow("ลูกค้า", request.clientName),
          detailRow("Campaign", request.campaignName),
          detailRow("Ad account", accountSuffix(request.advertiserId)),
          detailRow("งบเดิม", formatMoney(request.currentBudget, request.currency)),
          detailRow("งบใหม่", formatMoney(request.proposedBudget, request.currency)),
          detailRow("เพิ่ม", formatMoney(request.proposedBudget - request.currentBudget, request.currency)),
          lineText(dryRun
            ? "DRY-RUN เท่านั้น: เมื่อยืนยัน ระบบจะบันทึกผลทดสอบและจะไม่เรียก TikTok หรือเปลี่ยนงบจริง"
            : "ระบบจะอ่านบัญชีและงบจริงซ้ำก่อนแก้ หากข้อมูลเปลี่ยนไปคำสั่งนี้จะถูกยกเลิก", {
            size: "xs",
            color: "#666666",
            margin: "md"
          })
        ]
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          {
            type: "button",
            style: "primary",
            color: "#06C755",
            action: {
              type: "postback",
              label: dryRun ? "ยืนยันการทดสอบ" : "ยืนยันเพิ่มงบ",
              data: `a=confirm&id=${request.id}&v=${request.version}`,
              displayText: dryRun ? "ยืนยันการทดสอบ" : "ยืนยันเพิ่มงบ"
            }
          },
          {
            type: "button",
            style: "secondary",
            action: { type: "postback", label: "ยกเลิก", data: `a=reject&id=${request.id}`, displayText: "ยกเลิก" }
          }
        ]
      }
    }
  };
}

export function buildResultMessage({ request, ok, detail, dryRun = false, pending = false }) {
  const heading = pending
    ? "⏳ TikTok รับคำสั่งแล้ว—กำลังตรวจสอบผล"
    : dryRun
      ? "🧪 ทดสอบสำเร็จ (ยังไม่แก้งบ)"
      : ok
        ? "✅ ปรับงบแล้ว"
        : "❌ เพิ่มงบไม่สำเร็จ";
  const lines = [
    heading,
    `${request.clientName} — ${request.campaignName}`,
    `${formatMoney(request.currentBudget, request.currency)} → ${formatMoney(request.proposedBudget, request.currency)}`,
    `Audit: ${request.id.slice(0, 12)}`
  ];
  if (detail) lines.push(detail);
  return { type: "text", text: lines.join("\n") };
}

export function buildObservedBudgetChangeMessage({
  clientName,
  campaignName,
  currency,
  previousBudget,
  observedBudget,
  requestId,
  telemetryOnly = false
}) {
  const lines = [
    telemetryOnly ? "✅ ตรวจพบว่าปรับงบแล้ว" : "✅ ปรับงบแล้ว",
    `${clientName} — ${campaignName}`,
    `${formatMoney(previousBudget, currency)} → ${formatMoney(observedBudget, currency)}`,
    telemetryOnly
      ? "ตรวจยืนยันจาก signed Chrome telemetry — ระบบนี้ไม่ได้แก้ TikTok"
      : "ระบบตรวจยืนยันงบใหม่แล้ว",
    `Audit: ${String(requestId).slice(0, 12)}`
  ];
  return { type: "text", text: lines.join("\n") };
}

export class LineClient {
  constructor({
    accessToken,
    fetchImpl = globalThis.fetch,
    apiBase = LINE_API_BASE,
    replyTimeoutMs = 1_500,
    pushTimeoutMs = 10_000
  }) {
    if (!accessToken) throw new Error("LINE access token is required");
    this.accessToken = accessToken;
    this.fetch = fetchImpl;
    this.apiBase = apiBase;
    this.replyTimeoutMs = replyTimeoutMs;
    this.pushTimeoutMs = pushTimeoutMs;
  }

  async #request(path, payload, { retryKey, timeoutMs = this.pushTimeoutMs } = {}) {
    const headers = {
      authorization: `Bearer ${this.accessToken}`,
      "content-type": "application/json"
    };
    if (retryKey) headers["x-line-retry-key"] = retryKey;
    let response;
    try {
      response = await this.fetch(`${this.apiBase}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (cause) {
      const error = new Error(`LINE transport failed: ${cause?.message ?? "network error"}`);
      error.code = "LINE_TRANSPORT_ERROR";
      error.retryable = true;
      error.cause = cause;
      throw error;
    }
    if (response.status === 409 && retryKey) {
      const acceptedRequestId = response.headers.get("x-line-accepted-request-id");
      if (acceptedRequestId) return { duplicate: true, acceptedRequestId };
    }
    if (!response.ok) {
      const body = await response.text();
      let lineError = null;
      try {
        lineError = JSON.parse(body);
      } catch {
        // LINE occasionally returns a non-JSON proxy response; retain only the
        // bounded text already included in the Error message below.
      }
      const error = new Error(`LINE API ${response.status}: ${body.slice(0, 500)}`);
      error.status = response.status;
      error.retryable = response.status === 429 || response.status >= 500;
      error.recipientPermanent = response.status === 400
        && lineError?.details?.some((detail) => detail?.property === "to") === true;
      throw error;
    }
    return { duplicate: false };
  }

  async reply(replyToken, messages) {
    return this.#request(
      "/reply",
      { replyToken, messages: Array.isArray(messages) ? messages : [messages] },
      { timeoutMs: this.replyTimeoutMs }
    );
  }

  async push(to, messages, retryKey = crypto.randomUUID()) {
    const payload = { to, messages: Array.isArray(messages) ? messages : [messages] };
    let lastError;
    for (const waitMs of [0, 200, 800]) {
      if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
      try {
        return await this.#request("/push", payload, { retryKey });
      } catch (error) {
        lastError = error;
        if (!error.retryable && (error.status < 500 || error.status > 599)) throw error;
      }
    }
    throw lastError;
  }
}
