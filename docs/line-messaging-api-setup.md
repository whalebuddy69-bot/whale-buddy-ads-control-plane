# เปิด Messaging API สำหรับ LINE Official Account

ขั้นตอนนี้สร้าง Messaging API channel ให้ OA ที่มีอยู่ ยังไม่ต้องเปิด webhook และห้ามส่ง Channel secret หรือ Channel access token ผ่านแชต

สถานะ Pilot: OA `Whale Buddy Ads`, Provider `Whalebuddy Ads Automation`, Channel ID `2010756294` เปิด Messaging API แล้ว แต่ webhook ต้องคงเป็น **disabled** จนกว่าจะมี public HTTPS host

## ระยะที่ 1: เปิด Messaging API

1. เข้า [LINE Official Account Manager](https://manager.line.biz/) และเลือก OA ที่จะใช้รับอนุมัติงบ
2. เปิด `Settings` แล้วเลือก `Messaging API`
3. กด `Use Messaging API`
4. หากเป็นครั้งแรก ให้ลงทะเบียน developer name และ email
5. เลือก Provider ที่เป็นของบริษัท/เอเจนซีเดียวกัน ถ้ายังไม่มีให้สร้าง Provider สำหรับเอเจนซี
6. ตรวจชื่อ Provider ให้แน่ใจก่อนยืนยัน เพราะ LINE ไม่อนุญาตให้ย้ายหรือถอด Provider ของ OA ภายหลัง
7. หลังเปิดสำเร็จ เข้า [LINE Developers Console](https://developers.line.biz/console/), เลือก Provider และตรวจว่ามี Messaging API channel ของ OA นี้

ส่งกลับมาเฉพาะข้อมูลที่ไม่ใช่ความลับ:

- ชื่อ Provider
- Channel ID
- ชื่อ LINE Official Account

## ระยะที่ 2: ทำหลังมีระบบ HTTPS แล้ว

1. ใน LINE Developers Console เปิด channel แล้วไปที่ `Messaging API`
2. ตั้ง Webhook URL เป็น `https://<host>/webhooks/line`
3. กด `Verify` และต้องได้ `Success`
4. เปิด `Use webhook`
5. เปิด `Webhook redelivery`
6. เปิด `Error statistics aggregation`
7. ปิด Greeting message และ Auto-reply message หากไม่ต้องการข้อความซ้ำกับระบบอนุมัติ
8. เพิ่ม OA เป็นเพื่อน แล้วทำ one-time approver pairing ตามขั้นตอนด้านล่าง

## จับคู่ผู้อนุมัติแบบใช้ครั้งเดียว

ผู้ดูแลระบบเรียก endpoint นี้จาก environment ที่ปลอดภัยหลัง deploy แล้ว:

```bash
curl -X POST https://<host>/admin/line-pairings \
  -H "Authorization: Bearer <admin-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"clientId":"punpan_020","ttlMinutes":10}'
```

นำเฉพาะค่า `command` จากผลลัพธ์ไปส่งจากบัญชี LINE ของผู้อนุมัติใน **แชตส่วนตัวกับ OA** ห้ามจับคู่ในกลุ่ม รหัสใช้ได้ครั้งเดียว, ค่า TTL ต้องเป็นจำนวนเต็ม 2–60 นาที และการออกรหัสใหม่จะยกเลิกรหัสเก่าที่ยังไม่ได้ใช้

ระบบบันทึกเฉพาะ SHA-256 hash ของรหัสจับคู่ ไม่บันทึกรหัส plaintext ห้ามนำ Channel secret, Channel access token หรือ admin key ไปส่งใน LINE

## Secret ที่ต้องเก็บในระบบเท่านั้น

- Channel secret จากแท็บ `Basic settings`
- Channel access token จากแท็บ `Messaging API`

เก็บทั้งสองค่าใน secret manager ของระบบ deploy ไม่ใส่ในไฟล์ config, Git, screenshot หรือแชต

## เอกสารทางการ

- [Get started with the Messaging API](https://developers.line.biz/en/docs/messaging-api/getting-started/)
- [Build a bot](https://developers.line.biz/en/docs/messaging-api/building-bot/)
- [Receive messages and webhook redelivery](https://developers.line.biz/en/docs/messaging-api/receiving-messages/)
- [Verify webhook URL](https://developers.line.biz/en/docs/messaging-api/verify-webhook-url/)
- [Verify webhook signature](https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/)
