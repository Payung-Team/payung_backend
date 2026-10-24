# PYG-706 · QA Email format validation (FE + BE)

- รัน: 2026-10-24 · Created By / Execute By: Wasan. R
- BE: `origin/dev` @ `fea9a5b` ทดสอบด้วย `test/pyg706-email-validation.e2e-spec.ts` (DTO จริง 7 ตัว ผ่าน `ValidationPipe` ตั้งค่าเดียวกับ `main.ts` ไม่ต้องใช้ DB)
- FE: `payung_frontend` `origin/dev` @ `ebdb6c4` — ตรวจโค้ดและรัน regex จริงด้วย node (ยังไม่ได้ทดสอบบนเบราว์เซอร์ / ไม่มี screenshot)
- ข้อมูล: query นับจำนวนบนฐาน dev (Supabase `evsewucpighcbnhofmug`) อย่างเดียว ไม่ดึงอีเมลจริง
- **ผล: BE ไม่ผ่าน 5 เคส (21–25) + ข้อความ error → PYG-707 · FE ไม่ผ่าน 10 เคส + ข้อความ 3 แบบ + ช่องอีเมลหน้าชำระเงิน → PYG-708**

## 0. จุดที่มีช่องอีเมล

| ฝั่ง | จุด | ตรวจรูปแบบด้วย |
|---|---|---|
| BE | `RegisterInput`, `LoginInput`, `RequestPasswordResetInput` | `@IsEmail({}, { message: 'Invalid email format' })` |
| BE | `InviteAdminInput`, `AdminEditUserInput`, `EditAdminInfoInput`, `AdminUpdateCaregiverInfoInput` | `@IsEmail()` (ข้อความ default) |
| FE | Login, Register, ForgotPassword, AdminUsersPage (เชิญ / แก้ผู้ใช้) | `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` |
| FE | PaymentPage "อีเมลรับใบเสร็จ" | เช็คแค่ไม่ว่าง · ค่าไม่ถูกส่งไปไหน |
| FE | CaregiverEditProfile, AccountSettingsTab | อ่านอย่างเดียว |
| — | ฟอร์มจองบริการ | ไม่มีช่องอีเมล |

## 1. ผลต่อเคส

| TC | เคส (expected จากการ์ด) | BE | FE |
|---|---|---|---|
| PYG-706_01–05 | valid 4 แบบ + `User@Example.COM` → ผ่าน | ✅ | ✅ |
| PYG-706_06 | ยาว 254 → ผ่าน | ✅ | ✅ |
| PYG-706_07 | ไม่มี `@` | ✅ | ✅ |
| PYG-706_08 | ไม่มี domain | ✅ | ✅ |
| PYG-706_09 | ไม่มี local part | ✅ | ✅ |
| PYG-706_10 | ไม่มี TLD | ✅ | ✅ |
| PYG-706_11 | `@` สองตัว | ✅ | ✅ |
| PYG-706_12 | มีช่องว่าง | ✅ | ✅ |
| PYG-706_13 | จุดติดกัน | ✅ | ❌ ผ่าน |
| PYG-706_14 | ขึ้นต้นด้วยจุด | ✅ | ❌ ผ่าน |
| PYG-706_15 | ลงท้าย local ด้วยจุด | ✅ | ❌ ผ่าน |
| PYG-706_16 | ค่าว่าง | ✅ | ✅ |
| PYG-706_17 | ยาว 255 | ✅ | ❌ ผ่าน |
| PYG-706_18–19 | ช่องว่างหน้า/หลัง → แจ้ง error (ไม่ trim) | ✅ | ✅ |
| PYG-706_20 | NBSP แฝง | ✅ | ✅ |
| PYG-706_21 | `user!#@example.com` | ❌ ผ่าน* | ❌ ผ่าน* |
| PYG-706_22 | ภาษาไทยใน local part | ❌ ผ่าน | ❌ ผ่าน |
| PYG-706_23 | ภาษาไทยใน domain | ❌ ผ่าน | ❌ ผ่าน |
| PYG-706_24 | zero-width space แฝง (copy-paste) | ❌ ผ่าน | ❌ ผ่าน |
| PYG-706_25 | BOM แฝง | ❌ ผ่าน | ✅ (`\s` ของ JS นับ BOM) |
| — | `user@example..com`, `user@.example.com` | ✅ | ❌ ผ่าน |
| PYG-706_26–27 | ข้อความ error ตรงกัน ภาษาไทย | ❌ 2 แบบ อังกฤษ | ❌ 3 แบบ |

\* ตาม RFC 5322 `!` `#` เป็นอักขระที่ใช้ได้ — การ์ดบอกให้ปฏิเสธ รอเคาะใน PYG-707

BE: ค่าที่ไม่ผ่านทุกตัวตอบ `BadRequestException` 400 ก่อนถึง service · FE ที่ regex หลวม → ผู้ใช้ไม่เห็น error ใต้ช่อง แล้วไปเจอ 400 ภาษาอังกฤษจาก BE (หรือ BE รับไปเลยสำหรับอักขระซ่อน/ภาษาไทย)

## 2. ข้อสังเกต

- BE ไม่ normalize: `public.users.email` เก็บตามที่พิมพ์ ส่วน Supabase Auth เก็บตัวเล็ก → ฐาน dev มี 34 บัญชีที่สองที่ต่างกันแค่ตัวพิมพ์ (ที่อยู่เดียวกัน · ไม่มีบัญชีซ้ำแบบต่างตัวพิมพ์ · ไม่มีช่องว่าง/อักขระซ่อนในข้อมูลปัจจุบัน)
- หน้าแอดมินใช้ `type="email"` ใน `<form>` → เบราว์เซอร์อาจแสดง tooltip ของตัวเองก่อนข้อความของหน้า

## 3. ยังไม่ได้ทดสอบ

- บนเบราว์เซอร์จริง + screenshot (on blur / สีช่อง / ปุ่ม submit)
- ฐาน production (`payung-prod-db`) — ไม่มีสิทธิ์อ่าน

## 4. รันซ้ำ

```bash
npx jest --config test/jest-e2e.json test/pyg706-email-validation.e2e-spec.ts
```
