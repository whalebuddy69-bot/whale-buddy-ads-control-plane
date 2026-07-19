# Pilot: punpan_020

สถานะปัจจุบัน: dynamic policy และ LINE pairing พร้อมในโค้ด แต่ยังเป็น Discovery/read-only — `EXECUTION_ENABLED=false` และ LINE webhook ยังไม่เปิดจนกว่าจะมี public HTTPS host

## ยืนยันแล้ว

- Chrome tab group: `Ppan`
- Advertiser ID: `7646832328389263378`
- Business Center ID: `7627179356976201745`
- TikTok account: `ปุญญ์ปัญญ์ช็อป(ช่องจริง)` (`7285935731820920833`)
- LIVE window: `06:00–23:00` Asia/Bangkok
- Hard cap: `6,000 THB` มีผลตั้งแต่ 2026-07-19 จนกว่าจะมีคำสั่งใหม่จากเจ้าของ
- แจ้งเตือนเมื่อใช้ถึง `80%` ของงบปัจจุบัน
- ปุ่มงบมาตรฐาน: `+20%` (เท่ากับคูณ `1.2`) และ `ระบุเอง`
- ผู้อนุมัติ: 1 คน ผ่าน LINE
- LINE OA: `Whale Buddy Ads` (internal-only)
- LINE Provider: `Whalebuddy Ads Automation`
- LINE Channel ID: `2010756294`
- แคมเปญ Active ที่ตรวจพบวันที่ 2026-07-19: `1871072292203826`

แคมเปญ LIVE ถูกสร้างใหม่เป็นรายวัน ระบบจึงต้อง resolve แคมเปญ Active จาก advertiser + TikTok account ทุกครั้ง และต้องหยุดแบบ fail-closed หากพบมากกว่าหนึ่งแคมเปญที่ตรงกัน

Policy revision ปัจจุบันคือ `1`: เมื่อยอดใช้จ่ายถึง `80%` ระบบเสนอเพิ่มจากงบปัจจุบัน `20%` (เช่น `1,000 → 1,200 THB`) และอนุญาตให้ระบุยอดใหม่ผ่าน LINE ได้ โดยทั้งสองทางห้ามเกิน `6,000 THB` เพดานนี้มีผลตั้งแต่ `2026-07-19` จนกว่าเจ้าของจะออก revision ใหม่

## สถานะที่สังเกตจากหน้า TikTok Ads Manager

- ตรวจล่าสุด: `2026-07-19 22:45` Asia/Bangkok แบบ read-only
- งบรายวันปัจจุบัน: `5,000 THB`
- ใช้ไป: `4,622.84 THB` (`92.4568%`) ซึ่งเกิน threshold `80%`
- Target ROI: `40.00`
- หน้าแสดงคำแนะนำ `Consider increasing`
- มีคำเตือนว่ายอดเงินคงเหลืออาจหมดภายใน 7 วัน ซึ่งเป็นความเสี่ยงคนละประเภทกับ campaign budget และควรมี LINE alert แยกกัน
- URL ของ Ads Manager ใช้ `oec_seller_id=withoutShop`; Pilot จึงไม่ขอให้ผู้ใช้เปิด Seller Center และจะใช้ `observe-and-pin` แทนการเดา Store ID

## ต้องทำก่อนสร้าง config ใช้งานจริง

1. ทำ Chrome UI telemetry adapter และทดสอบ `observe-and-pin` โดยล็อก profile, tab group, advertiser, campaign และ TikTok account
2. Deploy HTTPS webhook ก่อนเปิด `Use webhook`
3. จับคู่ LINE user ID ของผู้อนุมัติแบบ one-time pairing
4. สมัคร TikTok API for Business developer app และ authorize advertiser ก่อนเปิด API write; ระหว่างนี้คง execution เป็น read-only/dry-run

ห้ามส่ง `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, TikTok access token, รหัสผ่าน หรือ OTP ผ่านแชต ให้กรอกลง secret manager ตอน deploy เท่านั้น

## จับคู่ผู้อนุมัติหลัง deploy HTTPS

1. ตั้งและ Verify `https://<host>/webhooks/line` ให้สำเร็จก่อน แล้วจึงเปิด `Use webhook` และ `Webhook redelivery`
2. ผู้ดูแลเรียก `POST /admin/line-pairings` ด้วย admin key ในระบบ:

   ```json
   {"clientId":"punpan_020","ttlMinutes":10}
   ```

3. ส่งค่า `command` ที่ endpoint คืนมา จาก LINE ของผู้อนุมัติไปยังแชตส่วนตัวของ `Whale Buddy Ads`
4. คำสั่งใช้ได้ครั้งเดียวและหมดอายุ ระบบเก็บเฉพาะ hash ของรหัส; การสร้างคำสั่งใหม่จะยกเลิกคำสั่งเก่าที่ยังไม่ได้ใช้

อย่าเปิด webhook ก่อนมี HTTPS endpoint ที่ออนไลน์ และอย่านำ Channel secret, access token หรือ admin key มาใส่ในคำสั่งจับคู่
