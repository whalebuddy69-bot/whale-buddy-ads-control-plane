# Whale Buddy LIVE GMV Telemetry (Pilot)

Chrome Extension แบบ Manifest V3 สำหรับอ่านตาราง LIVE GMV Max ที่มองเห็นบนหน้า TikTok Ads Manager และส่ง snapshot แบบ read-only ไป Render

## ขอบเขตความปลอดภัย

- ไม่มีสิทธิ์แก้งบ คลิกปุ่ม อ่าน cookie หรือดัก network ของ TikTok
- ระหว่างยังไม่มี TikTok API มี **page-refresh fallback** แบบ opt-out สำหรับ Pilot นี้: ค่าเริ่มต้นเปิดทุก 2 นาทีภายในเวลา LIVE แต่จะรีโหลดได้ต่อเมื่อ content script ยืนยันว่าไม่มีสัญญาณ edit/unsaved workflow
- อ่านเฉพาะหน้า `https://ads.tiktok.com/i18n/gmv-max/dashboard`
- ล็อก Pilot กับ advertiser `7646832328389263378`, Business Center `7627179356976201745`, TikTok account `7285935731820920833`, profile label `Whalebuddy Ads` และกลุ่มแท็บ `Ppan`
- DOM ไม่เปิดเผย `campaign_id` ส่วนขยายจึงส่ง `campaignId: null` และสร้าง `campaignRef` จาก advertiser ID + ชื่อ/เวลา campaign ที่มองเห็นเท่านั้น ห้ามเดา ID หรืออ่าน state ภายในของ TikTok
- กุญแจส่วนตัว P-256 สร้างในแต่ละ Chrome profile, เป็น non-extractable และเก็บใน IndexedDB ของส่วนขยาย; Render ได้เฉพาะ public key
- snapshot ทุกชุดเซ็น ECDSA P-256 แบบ raw 64-byte signature ก่อนส่ง

## ติดตั้งแบบ unpacked

1. เปิด Chrome profile **Whalebuddy Ads**
2. ไปที่ `chrome://extensions`
3. เปิด **Developer mode**
4. กด **Load unpacked** แล้วเลือกโฟลเดอร์ `extension/` นี้
5. เปิดหน้า LIVE GMV Max ของ `punpan_020` ไว้ในกลุ่มแท็บชื่อ **Ppan** เพียงกลุ่มเดียว
6. รีโหลดแท็บ TikTok หนึ่งครั้ง เพื่อให้ content script รุ่นที่ติดตั้งทำงาน
7. เปิดหน้าตั้งค่าของส่วนขยาย วาง one-time enrollment code 43 ตัวอักษร แล้วกด **เชื่อมต่อ**
8. กดไอคอนส่วนขยายและเลือก **อ่านค่าหน้าปัจจุบัน** เพื่อทดสอบการเชื่อมต่อโดยไม่รีเฟรชหน้า

หากอัปเดตจากรุ่น `0.1.x` ในโฟลเดอร์เดิม ให้กด **Reload** ที่การ์ด Extension และรีโหลดแท็บ TikTok หนึ่งครั้งเพื่อให้ content script รุ่นใหม่ทำงาน จากนั้น credential เดิมยังใช้ได้และ **ไม่ต้อง enroll ใหม่** หลังจาก setup ครั้งนี้ page-refresh fallback จะดูแลการ refresh ตามรอบเอง

Chrome ไม่มี API ที่ยืนยันชื่อ profile ที่ผู้ใช้ตั้งไว้ ชื่อ `Whalebuddy Ads` จึงเป็น label จาก enrollment; ตัว collector ยังตรวจ advertiser, Business Center, page type, seller mode, visible advertiser anchor, TikTok account และ campaign schedule ซ้ำทุกครั้ง

อย่าย้ายโฟลเดอร์ unpacked หลังเชื่อมต่อ เพราะ extension ID อาจเปลี่ยน เก็บ Chrome เปิดและ login TikTok ไว้; alarm ไม่ปลุกเครื่องที่ sleep และไม่ทำงานเมื่อ Chrome ปิด

## Page-refresh fallback ระหว่างรอ TikTok API

- ค่า Pilot: **เปิด**, ทุก **2 นาที**; alarm ตรวจทุก 1 นาที จึงอาจเริ่มช้ากว่ากำหนดเล็กน้อยตาม Chrome MV3 scheduling
- เปิด/ปิดและเลือก 2, 5, 10, 15 หรือ 30 นาทีได้จากหน้า **ตั้งค่าการเชื่อมต่อ**
- ปุ่ม **อ่านค่าหน้าปัจจุบัน** เป็น manual check ที่ไม่รีเฟรชหน้า
- ก่อนรีโหลด service worker ยืนยันอีกครั้งว่ามี tab group `Ppan` exactly one, dashboard exactly one และ URL มี advertiser, Business Center, seller mode และ page type ตรง Pilot
- content script ตรวจ URL และ Advertiser ID ที่มองเห็นซ้ำ แล้วอนุญาต reload เฉพาะเมื่อ document พร้อมและไม่พบ user activity ใน 5 นาทีล่าสุด, control ที่เปลี่ยนค่า, focused editor, dialog, `aria-busy` หรือ form submission ที่อาจยังไม่จบ
- หากตรวจไม่ผ่าน ระบบ **ไม่รีโหลดและไม่ส่ง snapshot รอบนั้น** เพื่อไม่ทำให้ข้อมูลเก่าดูเหมือนข้อมูลสด จากนั้นลองใหม่ใน alarm รอบถัดไป
- การตรวจ dirty state เป็น fail-closed: หลังมีการ edit/submit บางรูปแบบ fallback อาจหยุดรอจนผู้ใช้ reload หน้าเอง ซึ่งปลอดภัยกว่าการทำงานที่ยังไม่บันทึกหาย
- เมื่อ TikTok API monitor พร้อม ให้ปิด page-refresh fallback; การปิดจะหยุดการ reload อัตโนมัติทันทีโดยไม่กระทบ enrollment

ข้อจำกัด: Chrome ไม่รับประกันเวลา alarm แบบ real-time, Chrome ที่ปิด/เครื่อง sleep จะไม่ตรวจ และหน้าเว็บอาจเปลี่ยน DOM จน safety detector เลือกหยุดทำงาน หาก fallback หยุด ให้ตรวจสถานะใน popup ก่อนทำ manual reload

## DOM contract ที่ยอมรับ

- semantic `<table>` exactly one
- header 22 ช่องและทุก data row มี direct `<td>` 22 ช่อง
- exact headers: `Campaign name`, `Status`, `Available TikTok accounts`, `Target ROI budget`, `Cost`, `Total budget`, `Net Cost`
- campaign ต้องชื่อ `<วันที่ Asia/Bangkok> 06:00:00`, status `Active`
- account cell ต้องมี `ID: <digits>` exactly one และตรง ID ที่อนุญาต
- `Cost` และ `Net Cost` อ่านด้วย exact header คนละคอลัมน์ ไม่มี fuzzy fallback
- Daily budget อ่านจาก label `Daily budget:` exactly one; ยอมรับ suffix ที่ตรวจพบจริงเพียง `Consider increasing`

เมื่อ selector, header, account, URL, จำนวนแถว/คอลัมน์ หรือรูปแบบเงินไม่ตรง ระบบหยุดแบบ fail-closed และไม่ส่ง partial snapshot

## Backend contract

- enrollment: `POST /telemetry/chrome/enroll`
- snapshot: `POST /telemetry/chrome/snapshots`
- canonical signature message:

  ```text
  v1
  <credentialId>
  <unix timestamp seconds>
  <base64url nonce>
  <sha256(raw JSON body) hex>
  ```

Render origin ถูกล็อกไว้ที่ `https://whale-buddy-ads-control-plane.onrender.com`; หาก production URL ต่างจากนี้ ต้องเปลี่ยนทั้ง `lib/constants.js` และ exact `host_permissions` ใน `manifest.json` ก่อนติดตั้ง

## ทดสอบ

จาก repository root:

```bash
node --test extension/test/*.test.js
```

ชุดทดสอบครอบคลุม table fixture ปกติ, `Consider increasing`, header/row drift, Cost vs Net Cost, duplicate account ID, exact campaign schedule, deterministic campaignRef, non-extractable key, raw P-256 signature, refresh cadence/toggle, fail-closed edit signals และ minimal manifest permissions
