# Whale Buddy LIVE GMV Telemetry (Pilot)

Chrome Extension แบบ Manifest V3 สำหรับอ่านตาราง LIVE GMV Max ที่มองเห็นบนหน้า TikTok Ads Manager และส่ง snapshot แบบ read-only ไป Render

## ขอบเขตความปลอดภัย

- ไม่มีสิทธิ์แก้งบ คลิกปุ่ม รีโหลดแท็บ อ่าน cookie หรือดัก network ของ TikTok
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
8. กดไอคอนส่วนขยายและเลือก **ตรวจตอนนี้**

Chrome ไม่มี API ที่ยืนยันชื่อ profile ที่ผู้ใช้ตั้งไว้ ชื่อ `Whalebuddy Ads` จึงเป็น label จาก enrollment; ตัว collector ยังตรวจ advertiser, Business Center, page type, seller mode, visible advertiser anchor, TikTok account และ campaign schedule ซ้ำทุกครั้ง

อย่าย้ายโฟลเดอร์ unpacked หลังเชื่อมต่อ เพราะ extension ID อาจเปลี่ยน เก็บ Chrome เปิดและ login TikTok ไว้; alarm ไม่ปลุกเครื่องที่ sleep และไม่ทำงานเมื่อ Chrome ปิด

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

ชุดทดสอบครอบคลุม table fixture ปกติ, `Consider increasing`, header/row drift, Cost vs Net Cost, duplicate account ID, exact campaign schedule, deterministic campaignRef, non-extractable key, raw P-256 signature และ minimal manifest permissions
