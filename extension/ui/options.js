import { CONTROL_PLANE_ORIGIN, MESSAGE_TYPES } from "../lib/constants.js";

const form = document.querySelector("#enrollment-form");
const codeInput = document.querySelector("#enrollment-code");
const connectButton = document.querySelector("#connect-button");
const result = document.querySelector("#form-result");
const badge = document.querySelector("#connection-badge");
const currentStatus = document.querySelector("#current-status");
const manualCheck = document.querySelector("#manual-check");

function showResult(kind, text) {
  result.hidden = false;
  result.className = `form-result ${kind}`;
  result.textContent = text;
}

function renderStatus(status) {
  badge.className = `status-pill ${status?.mode ?? "error"}`;
  badge.textContent = status?.enrolled ? "เชื่อมต่อแล้ว" : "ยังไม่เชื่อมต่อ";
  currentStatus.textContent = status?.message ?? "อ่านสถานะไม่ได้";
  manualCheck.disabled = !status?.enrolled || status?.mode === "working";
  if (status?.enrolled) connectButton.textContent = "เชื่อมต่อใหม่";
}

async function refreshStatus() {
  try {
    renderStatus(await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.getStatus }));
  } catch {
    renderStatus({ mode: "error", enrolled: false, message: "ติดต่อส่วนทำงานเบื้องหลังไม่ได้" });
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const enrollmentCode = codeInput.value.trim();
  if (!/^[A-Za-z0-9_-]{43}$/u.test(enrollmentCode)) {
    showResult("error", "รหัสเชื่อมต่อต้องมี 43 ตัวอักษร กรุณาคัดลอกใหม่ทั้งชุด");
    return;
  }
  connectButton.disabled = true;
  connectButton.textContent = "กำลังเชื่อมต่อ…";
  result.hidden = true;
  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.enroll,
      enrollmentCode
    });
    codeInput.value = "";
    if (response?.ok) {
      showResult("success", "เชื่อมต่อสำเร็จแล้ว เปิดแท็บ TikTok ในกลุ่ม Ppan และกดตรวจตอนนี้ได้เลย");
    } else {
      showResult("error", response?.error?.message ?? "เชื่อมต่อไม่สำเร็จ กรุณาขอรหัสใหม่");
    }
  } catch {
    showResult("error", `ติดต่อ ${CONTROL_PLANE_ORIGIN} ไม่สำเร็จ กรุณาตรวจอินเทอร์เน็ต`);
  } finally {
    connectButton.disabled = false;
    connectButton.textContent = "เชื่อมต่อ";
    await refreshStatus();
  }
});

manualCheck.addEventListener("click", async () => {
  manualCheck.disabled = true;
  manualCheck.textContent = "กำลังตรวจ…";
  const response = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.checkNow }).catch(() => null);
  if (response?.ok) showResult("success", "อ่านและส่งข้อมูลล่าสุดสำเร็จ");
  else showResult("error", response?.error?.message ?? "ตรวจหน้า TikTok ไม่สำเร็จ");
  manualCheck.textContent = "ตรวจหน้า TikTok ตอนนี้";
  await refreshStatus();
});

void refreshStatus();
