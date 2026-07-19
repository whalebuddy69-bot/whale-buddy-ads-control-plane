# Onboarding checklist

## TikTok

- [ ] สมัคร TikTok for Business developer และสร้าง developer app
- [ ] ขอ permission อ่าน campaign, แก้ campaign และ `Reporting > GMV MAX Report`
- [ ] ตั้ง OAuth callback URL แบบ HTTPS
- [ ] ให้ agency user authorize app และแลก `auth_code` เป็น access token
- [ ] ตรวจรายชื่อ advertiser IDs ที่ app ได้รับสิทธิ์ด้วย `/oauth2/advertiser/get/`; access ในหน้าเว็บไม่ได้แปลว่า OAuth grant ครบทุกบัญชี
- [ ] แต่ละร้านกำหนด ad account หลัก/สิทธิ์ GMV Max ถูกต้อง
- [ ] เก็บ `advertiser_id`, `campaign_id`, TikTok account, currency และ timezone; ให้ campaign detail ค้นหาและ pin `store_id`/`store_authorized_bc_id` อัตโนมัติเมื่อใช้ `observe-and-pin`
- [ ] ทดสอบ `/campaign/gmv_max/info/` กับทุก campaign
- [ ] ทดสอบ `/gmv_max/report/get/` โดย filter Shop/LIVE/campaign และตรวจว่า `cost`/currency ตรง UI ในช่วง latency ที่ยอมรับได้
- [ ] ทดสอบ update ใน sandbox หรือ campaign งบต่ำที่สุดก่อน
- [ ] ตรวจว่า account-level Budget Manager cap และ account balance ไม่ใช่สาเหตุที่ delivery หยุด

หลักบัญชีสำคัญ: TikTok Shop หนึ่งร้านใช้ ad account ที่มี exclusive/primary GMV Max authorization ได้หนึ่งบัญชีในเวลาเดียวกัน แต่ Business Center ของ agency สามารถรับ authorization จากหลาย TikTok accounts ได้

## LINE

- [ ] สร้าง LINE Official Account + Messaging API channel
- [ ] ออก Channel Access Token ที่หมุนเวียนได้ และเก็บใน secret manager
- [ ] ตั้ง webhook `https://HOST/webhooks/line`
- [ ] ก่อนมี public HTTPS host ให้คง `Use webhook` เป็น disabled
- [ ] กด Verify ให้ได้ Success แล้วจึงเปิด Use webhook และ Webhook redelivery
- [ ] เพิ่ม OA เป็นเพื่อนจาก LINE ของผู้อนุมัติ
- [ ] เปิด `linePairingEnabled` ให้ client และสร้างคำสั่งใช้ครั้งเดียวผ่าน `POST /admin/line-pairings`
- [ ] ส่งคำสั่งจับคู่จากผู้อนุมัติในแชตส่วนตัวกับ OA; ตรวจว่า LINE user ID ถูกบันทึกแยกตาม client
- [ ] ทดสอบ signature, กดซ้ำ, custom amount, reject และ expired request

LINE Notify ใช้ไม่ได้แล้ว (ยุติบริการ 31 มีนาคม 2025) ระบบนี้ใช้ Messaging API เท่านั้น

## Hosting / operations

- [ ] Public HTTPS และ certificate ถูกต้อง
- [ ] ระหว่างรอ TikTok App ใช้ `CONTROL_PLANE_ONLY=true` และตรวจ health ว่า TikTok/Chrome adapters ยังปิดอยู่
- [ ] Persistent disk สำหรับ SQLite หรือ migrate เป็น PostgreSQL
- [ ] Secret manager สำหรับ LINE/TikTok/admin tokens
- [ ] Health monitor และ alert เมื่อ polling/API ล้มเหลว
- [ ] สำรอง audit database
- [ ] ตั้ง log retention โดยไม่ log access token หรือ raw Authorization header
- [ ] เริ่มด้วย `EXECUTION_ENABLED=false`
- [ ] ผ่าน low-budget end-to-end test แล้วค่อยเปิด execution
- [ ] มี operator kill switch และ runbook หาก TikTok API/UI เปลี่ยน
