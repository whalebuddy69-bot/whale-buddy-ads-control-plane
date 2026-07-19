import { MESSAGE_TYPES } from "../lib/constants.js";

const elements = {
  dot: document.querySelector("#status-dot"),
  label: document.querySelector("#status-label"),
  message: document.querySelector("#status-message"),
  code: document.querySelector("#status-code"),
  clientId: document.querySelector("#client-id"),
  profile: document.querySelector("#profile-name"),
  tabGroup: document.querySelector("#tab-group"),
  snapshotCard: document.querySelector("#snapshot-card"),
  cost: document.querySelector("#cost-value"),
  budget: document.querySelector("#budget-value"),
  observedAt: document.querySelector("#observed-at"),
  checkNow: document.querySelector("#check-now"),
  openOptions: document.querySelector("#open-options")
};

const modeLabels = {
  healthy: "ทำงานปกติ",
  working: "กำลังตรวจ",
  ready: "พร้อมทำงาน",
  waiting: "กำลังรอ",
  error: "ต้องตรวจสอบ",
  not_enrolled: "ยังไม่เชื่อมต่อ"
};

function money(minor, currency = "THB") {
  return new Intl.NumberFormat("th-TH", {
    style: "currency",
    currency,
    minimumFractionDigits: 2
  }).format(minor / 100);
}

function thaiTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("th-TH", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "Asia/Bangkok"
  }).format(new Date(value));
}

function render(status) {
  const mode = status?.mode ?? "error";
  elements.dot.className = `status-dot ${mode}`;
  elements.label.className = `status-pill ${mode}`;
  elements.label.textContent = modeLabels[mode] ?? "สถานะระบบ";
  elements.message.textContent = status?.message ?? "อ่านสถานะไม่ได้";
  elements.code.hidden = !status?.errorCode;
  elements.code.textContent = status?.errorCode ? `รหัส: ${status.errorCode}` : "";
  elements.clientId.textContent = status?.clientId ?? "punpan_020";
  elements.profile.textContent = status?.browserProfile ?? "Whalebuddy Ads";
  elements.tabGroup.textContent = status?.tabGroup ?? "Ppan";
  elements.checkNow.disabled = !status?.enrolled || mode === "working";

  const snapshot = status?.lastSnapshot;
  elements.snapshotCard.hidden = !snapshot;
  if (snapshot) {
    elements.cost.textContent = money(snapshot.costMinor, snapshot.currency);
    elements.budget.textContent = money(snapshot.dailyBudgetMinor, snapshot.currency);
    elements.observedAt.textContent = `ข้อมูลจากหน้า TikTok: ${thaiTime(snapshot.observedAt)}`;
  }
}

async function refresh() {
  try {
    render(await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.getStatus }));
  } catch {
    render({ mode: "error", message: "ติดต่อส่วนทำงานเบื้องหลังไม่ได้", errorCode: "WORKER_UNAVAILABLE" });
  }
}

elements.checkNow.addEventListener("click", async () => {
  elements.checkNow.disabled = true;
  elements.checkNow.textContent = "กำลังตรวจ…";
  await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.checkNow }).catch(() => null);
  elements.checkNow.textContent = "ตรวจตอนนี้";
  await refresh();
});

elements.openOptions.addEventListener("click", () => chrome.runtime.openOptionsPage());

void refresh();
