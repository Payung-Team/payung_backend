-- PYG-651 follow-up: ชื่อ E11 ใช้แบบสั้น (Sammy เคาะ 8 ต.ค. 2026)
-- Hand-written. Deploy only via `prisma migrate deploy` after Sammy approves.
--
-- production มีแถว E11 ชื่อสั้นอยู่ก่อนแล้ว (เขียนก่อน 20261008080000 ซึ่ง INSERT … ON CONFLICT DO NOTHING จึงไม่แตะ)
-- → บน production ไฟล์นี้ไม่เปลี่ยนแถวใด · บน DB ที่สร้างจาก migrations ล้วนจะแก้ชื่อยาวให้ตรงกับ production
-- Safe to re-run: UPDATE จับคู่ด้วย code + ชื่อเดิม

UPDATE "care_activities"
   SET "name_th"    = 'ทำแผลกดทับรุนแรง',
       "updated_at" = now()
 WHERE "code" = 'E11'
   AND "name_th" = 'ทำแผลกดทับรุนแรง (ไม่รวมระดับ 4 หรือแผลติดเชื้อ)';
