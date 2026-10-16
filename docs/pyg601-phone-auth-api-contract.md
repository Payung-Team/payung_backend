# PYG-601 — API Contract: ขอรหัสยืนยัน · ยืนยันรหัส · สมัคร · ล็อกอิน · ผูกเบอร์โทร

> Story แม่: **PYG-562** (S07 · ผู้ใช้ทุก role สมัครและล็อกอินด้วยเบอร์โทรศัพท์ที่ยืนยันแล้ว เพิ่มจากอีเมล)
> ผู้ใช้ contract: **PYG-603** [BE] · **PYG-604** [FE] · **PYG-605** [QA] · อ้างอิงฝั่ง DB: **PYG-602** (PR #107)
> สถานะ: **ร่างให้ BE/FE รีวิว** — เขียนบน branch `feature/pyg-601` วันที่ 2026-10-16
> BE ที่ทำตาม contract นี้อยู่บน branch `feature/pyg-603` — ตรวจแล้วว่า operation ทั้ง 6 ตัวของ FE (`phoneAuth.ts`)
> validate ผ่านกับ `schema.gql` ที่ BE สร้าง และ error ตอบ HTTP 200 + `extensions.code` จริง (เทส e2e `test/pyg603-*`)

เอกสารนี้ส่งมอบ "ข้อตกลง" ไม่ใช่โค้ด — โค้ดของ BE ที่ทำตาม contract นี้อยู่ใน PYG-603
ทุกชื่อในเอกสาร **เทียบกับโค้ดจริงแล้ว** (`payung_backend` บน `dev` @ `3eeceb8` และ `payung_frontend`
บน `dev` @ `25734e4` ไฟล์ `src/graphql/phoneAuth.ts`, `src/lib/phoneAuthErrors.ts`)

---

## 0. สรุปสั้นที่สุด (TL;DR)

| เรื่อง | ข้อตกลง |
|---|---|
| ใครสร้าง/ตรวจรหัส | **Supabase Auth** (มติ 7 ต.ค. · Sammy) — BE ไม่สร้างรหัสเอง ไม่มีตาราง `phone_verifications` |
| Operation | `requestPhoneOtp` · `verifyPhoneOtp` · `signUpWithPhone` · `loginWithPhone` · `linkPhone` · field ใหม่ `User.phoneVerified` |
| ชื่อและรูปทรง | **ตรงกับที่ FE เขียนไว้แล้วใน `src/graphql/phoneAuth.ts` ทุกตัว** — FE ไม่ต้องแก้ query เลย |
| ข้อเสนอของ FE 2 ข้อ | **รับทั้งคู่**: (1) มี `verifyPhoneOtp` → `verificationToken` (2) เวลาเป็นจำนวนวินาที |
| Response ของ login/สมัคร | `AuthPayload` ตัวเดียวกับ `login` / `register` เดิม (S07-AC5) |
| รูปแบบเบอร์ขาเข้า | รับ `+66812345678`, `66812345678`, `0812345678`, มีขีด/ช่องว่างได้ · เฉพาะ **มือถือไทย 06/08/09** |
| รูปแบบเบอร์ขาออก | `User.phone` = **`0812345678`** (10 หลัก) — เหตุผลใน §3.2 (ต่างจากข้อเสนอเดิม) |
| Error | **HTTP 200** + `errors[0].extensions.code` (แบบเดียวกับ `CONSENT_*`, `FamilyGroupError`) ไม่ใช่ 422 — เหตุผลใน §6.1 |
| `email` | `User.email` และ type อื่นอีก 6 ตัวเปลี่ยนเป็น **nullable** · `UserSummary` เพิ่ม `phone` |
| ตัวเลข R8 | อ่านจาก env ทั้งหมด ไม่ฝังในโค้ด — ค่าเริ่มต้นใน §7 |

---

## 1. มติที่ contract นี้ยึด และคำตอบของประเด็นที่ "ติดอยู่" ใน PYG-562

| ประเด็นที่ติดอยู่ (story) | คำตอบ | ที่มา |
|---|---|---|
| ระบบยืนยันตัวตนปัจจุบันทำงานอย่างไร | ใช้ **Supabase Auth** — `login` เรียก `signInWithPassword`, guard ตรวจ token ด้วย `supabase.auth.getUser(token)` แล้วหา `public.users` จาก `supabase_uid` | โค้ด `auth.service.ts`, `supabase-auth.guard.ts` · คอมเมนต์ PYG-602 |
| วิธียืนยันเบอร์ | **Supabase Auth phone OTP** — `signInWithOtp` / `verifyOtp` / เปลี่ยนเบอร์ผ่าน `PUT /auth/v1/user` | มติ 7 ต.ค. (คอมเมนต์ PYG-602 2026-10-08) |
| ล็อกอินด้วยเบอร์ใช้อะไร | **รหัส OTP ทาง SMS ทุกครั้ง** (ไม่มีรหัสผ่าน) — ตรงกับ Design PYG-600 (Done) และ FE ที่เขียนแล้ว | PYG-600, PYG-604 |
| ผู้ให้บริการ SMS / ใครจ่าย / งบ | **ยังไม่เคาะ** — แต่ไม่บล็อกโค้ดแล้ว: ผู้ให้บริการตั้งที่ Supabase Dashboard (Twilio / MessageBird / Vonage / Textlocal) เปลี่ยนรายได้โดยไม่แก้โค้ด BE เลย | ดู §10 ข้อ 1 |

ผลของมติต่อ contract:

- "1 เบอร์ 1 บัญชี" (R3, S07-AC3) ถูกบังคับที่ `auth.users` (`UNIQUE (phone)` = `users_phone_key`) และสถานะยืนยันอยู่ที่
  `auth.users.phone_confirmed_at` → **ไม่มี** `users.phone_verified_at` และ **ไม่มี** unique index บน `public.users.phone`
- `public.users.phone` ยังเป็น "เบอร์ในโปรไฟล์" เหมือนเดิม (มีเบอร์ซ้ำ 4 กลุ่ม / 13 บัญชีอยู่แล้ว ซึ่งไม่กระทบ เพราะการล็อกอินไม่ได้หาจากคอลัมน์นี้)
- trigger `on_google_auth_user_created` ทำงานเฉพาะ `provider = 'google'` (ตรวจจาก DB จริงแบบอ่านอย่างเดียว 2026-10-16)
  → การสมัครด้วยเบอร์ผ่าน Supabase **ไม่** สร้างแถว `public.users` เอง BE เป็นคนสร้างหลังยอมรับเงื่อนไขเท่านั้น (E12)

---

## 2. ภาพรวม flow

```
สมัคร (SIGNUP) — ตาม PYG-600: ยืนยันเบอร์ → เลือก role → อ่านและยอมรับเงื่อนไข → สร้างบัญชี
  FE                                 BE                                   Supabase Auth
  requestPhoneOtp(phone, SIGNUP) ──▶ ตรวจรูปแบบ · ตรวจซ้ำ · rate limit ──▶ signInWithOtp(shouldCreateUser) ──▶ SMS
  verifyPhoneOtp(phone, code)    ──▶ นับครั้งที่ผิด                    ──▶ verifyOtp(type: sms)
                                 ◀── verificationToken (อายุ 30 นาที, ยังไม่มีแถวใน public.users)
  (ผู้ใช้เลือก role + อ่านเงื่อนไข)
  signUpWithPhone(token, role, consents) ─▶ ตรวจ consent · สร้าง users + user_consents ในทรานแซคชันเดียว
                                 ◀── AuthPayload { accessToken, refreshToken, user }

ล็อกอิน (LOGIN)
  requestPhoneOtp(phone, LOGIN)  ──▶ ต้องเป็นเบอร์ที่ยืนยันแล้วของบัญชีที่มีอยู่ ──▶ signInWithOtp(no create) ──▶ SMS
  loginWithPhone(phone, code)    ──▶ verifyOtp(type: sms) ──▶ AuthPayload (รูปเดียวกับ login อีเมล)

ผูกเบอร์ (LINK) — ต้องล็อกอินอยู่ (ส่ง Authorization: Bearer <accessToken> เหมือน request อื่น)
  requestPhoneOtp(phone, LINK)   ──▶ ตรวจว่าไม่ใช่เบอร์ของบัญชีอื่น ──▶ PUT /auth/v1/user { phone } (ในนามผู้ใช้) ──▶ SMS
  linkPhone(phone, code)         ──▶ verifyOtp(type: phone_change) · ตรวจว่าเป็นบัญชีของผู้เรียก · เขียน users.phone
                                 ◀── User { id phone phoneVerified: true }
```

---

## 3. รูปแบบเบอร์โทร (R4, R7)

### 3.1 ขาเข้า — ทุก operation ที่มี `phone`

- BE ตัดทุกอย่างที่ไม่ใช่ตัวเลขทิ้งก่อน (ขีด, ช่องว่าง, วงเล็บ, `+`) แล้วรับ 3 รูปแบบ:
  `0XXXXXXXXX` (10 หลัก) · `66XXXXXXXXX` (11 หลัก) · `660XXXXXXXXX` (คนพิมพ์ 0 ซ้ำหลังรหัสประเทศ)
- ต้องเป็น **มือถือไทย**: เลขหลังเลข 0 นำหน้าขึ้นต้นด้วย `6`, `8` หรือ `9` และยาว 9 หลัก — กฎเดียวกับ `phoneInputIssue()` ของ FE
- ไม่ผ่าน → `PHONE_INVALID_FORMAT` **ก่อน** เรียก Supabase ทุกครั้ง ไม่เสียค่า SMS (R7)
- FE ส่ง E.164 (`+66812345678`) อยู่แล้ว — ใช้ต่อได้ ไม่ต้องแก้

### 3.2 ขาออก — `User.phone` คืน `0812345678` (★ ต่างจากข้อเสนอเดิมที่ว่า "ส่งกลับเป็น E.164 เสมอ")

- `auth.users.phone` (ตัวตนที่ใช้ล็อกอิน) เก็บแบบ E.164 — นี่คือ "รูปแบบมาตรฐานเดียว" ของ R4
- `public.users.phone` (เบอร์ในโปรไฟล์) **ไม่ถูกแปลง** ตามมติ PYG-602 — ข้อมูลเดิม 28 แถวเป็น `0XXXXXXXXX` ทั้งหมด
  BE จึงเขียนเบอร์ของบัญชีที่สมัคร/ผูกด้วยเบอร์ในรูปเดียวกัน (`0812345678`) ให้ทั้งคอลัมน์มีรูปแบบเดียว
- เหตุผลเพิ่ม: `UpdateProfileInput.phone` มี `@MaxLength(10)` และหน้า Onboarding/KYC ของ FE ตรวจด้วย `/^0[0-9]{8,9}$/`
  ถ้า BE คืน `+66…` แล้วผู้ใช้กดบันทึกโปรไฟล์ ค่าที่ระบบเติมให้เองจะตรวจไม่ผ่าน (คอมเมนต์ PYG-602 ข้อ 3)
- FE ไม่ต้องแก้: `nationalDigits()` / `formatThaiPhone()` รับทั้งสองรูปแบบอยู่แล้ว

---

## 4. Operations

> SDL ด้านล่างคือรูปที่จะปรากฏใน `src/schema.gql` หลัง PYG-603
> ชื่อ input/payload type ภายในตั้งโดย BE — FE ไม่ได้อ้างชื่อ type เหล่านี้ตรง ๆ (ใช้ inline input) จึงไม่กระทบ

```graphql
enum PhoneOtpPurpose {
  SIGNUP   # สมัครบัญชีใหม่
  LOGIN    # ล็อกอินด้วยเบอร์ที่ยืนยันแล้ว
  LINK     # ผูกเบอร์กับบัญชีที่ล็อกอินอยู่ (ต้องส่ง Authorization)
}
```

### 4.1 `requestPhoneOtp` — ขอรหัสยืนยัน (public · LINK ต้องล็อกอิน)

```graphql
input RequestPhoneOtpInput { phone: String!  purpose: PhoneOtpPurpose! }
type PhoneOtpRequestPayload {
  resendAfterSeconds: Int!   # ขอรหัสใหม่ได้อีกกี่วินาที (เริ่มนับตอนได้ response)
  expiresInSeconds: Int!     # รหัสหมดอายุในกี่วินาที
}
type Mutation { requestPhoneOtp(input: RequestPhoneOtpInput!): PhoneOtpRequestPayload! }
```

```jsonc
// request
{ "query": "mutation RequestPhoneOtp($phone: String!, $purpose: PhoneOtpPurpose!) { requestPhoneOtp(input: { phone: $phone, purpose: $purpose }) { resendAfterSeconds expiresInSeconds } }",
  "variables": { "phone": "+66812345678", "purpose": "SIGNUP" } }
// response — ไม่มีรหัสใน response ใด ๆ (R10)
{ "data": { "requestPhoneOtp": { "resendAfterSeconds": 60, "expiresInSeconds": 60 } } }
```

ลำดับการตรวจ (ตัวแรกที่ไม่ผ่านคือ error ที่ได้):

1. `LINK` ไม่มี/มี token ไม่ถูกต้อง → `UNAUTHENTICATED` · บัญชีถูกระงับ → `FORBIDDEN` (ตรรกะเดียวกับ `SupabaseAuthGuard`
   — resolver ตรวจ token ก่อนอย่างอื่นเฉพาะ `LINK` · `SIGNUP`/`LOGIN` ไม่อ่าน header เลย)
2. รูปแบบเบอร์ → `PHONE_INVALID_FORMAT`
3. สถานะเบอร์ตามจุดประสงค์:
   - `SIGNUP`: เป็นเบอร์ที่ยืนยันแล้วของบัญชีที่มีอยู่ → `PHONE_ALREADY_IN_USE` (E4 — ตอบ **ตอนขอรหัส** ไม่เสียค่า SMS)
     · เบอร์ที่เคยเริ่มสมัครแล้วทิ้งไว้ (มีใน Supabase แต่ไม่มีบัญชีในระบบเรา) → สมัครต่อได้ (E12)
   - `LOGIN`: ไม่มีบัญชีที่ยืนยันเบอร์นี้ → ถ้ามีบัญชีที่กรอกเบอร์นี้ไว้ในโปรไฟล์แต่ยังไม่ยืนยัน `PHONE_NOT_VERIFIED` (E1)
     ไม่งั้น `PHONE_NOT_REGISTERED` (E6 — บอกตรง ๆ ตาม Design PYG-600)
   - `LINK`: เป็นเบอร์ของบัญชีอื่น → `PHONE_ALREADY_IN_USE` (E5)
     · เป็นเบอร์ที่ยืนยันแล้วของ **ผู้เรียกเอง** → `PHONE_ALREADY_IN_USE` พร้อมข้อความ "ผูกกับบัญชีของคุณอยู่แล้ว"
       (Supabase ไม่ส่ง SMS ถ้าเบอร์ไม่เปลี่ยน — ตอบทันทีแทนให้ผู้ใช้รอ SMS ที่ไม่มีวันมา) และ BE เขียน `users.phone` ให้ตรง
4. Rate limit (§7) → `OTP_RATE_LIMITED` + `extensions.resendAfterSeconds` (E10 — ไม่ส่ง SMS)
5. กดซ้ำขณะคำขอเดิมของเบอร์เดียวกันยังไม่จบ → `OTP_RATE_LIMITED` (กันส่ง SMS ซ้ำจากการกดรัว)
6. Supabase ส่ง SMS ไม่สำเร็จ / หมดเวลา / ยังไม่ได้เปิด phone provider → `SMS_SEND_FAILED` (E11 — ไม่นับเป็นการกรอกผิด และไม่กินโควตาของเบอร์)

ผลข้างเคียงที่ตั้งใจ: ขอรหัสใหม่ = รหัสเก่าของเบอร์นั้นใช้ไม่ได้ (Supabase เก็บรหัสล่าสุดตัวเดียว → E8) และตัวนับครั้งที่กรอกผิดเริ่มใหม่

### 4.2 `verifyPhoneOtp` — ตรวจรหัสของการสมัคร (public) ★ ข้อเสนอของ FE

```graphql
input VerifyPhoneOtpInput { phone: String!  code: String!  purpose: PhoneOtpPurpose! }
type PhoneVerificationPayload {
  verificationToken: String!   # ทึบ (opaque) — FE เก็บไว้ส่งให้ signUpWithPhone เท่านั้น ห้าม log
  expiresInSeconds: Int!       # token หมดอายุในกี่วินาที (ค่าเริ่มต้น 1800 = 30 นาที พอให้อ่านเงื่อนไข)
}
type Mutation { verifyPhoneOtp(input: VerifyPhoneOtpInput!): PhoneVerificationPayload! }
```

```jsonc
// request (FE ส่ง purpose: SIGNUP แบบ inline อยู่แล้ว)
{ "variables": { "phone": "+66812345678", "code": "123456" } }
// response
{ "data": { "verifyPhoneOtp": { "verificationToken": "v1.Zm9v…", "expiresInSeconds": 1800 } } }
```

- รับเฉพาะ `purpose: SIGNUP` — LOGIN ใช้ `loginWithPhone` และ LINK ใช้ `linkPhone` (purpose อื่น → `BAD_USER_INPUT`)
- **ยังไม่สร้างแถวใน `public.users`** — บัญชีเกิดหลังยอมรับเงื่อนไขใน `signUpWithPhone` เท่านั้น (E12, PYG-474)
- token = ข้อมูลที่ BE เข้ารหัส AES-256-GCM (ผู้ใช้ Supabase ที่ยืนยันเบอร์แล้ว + เวลาหมดอายุ) — FE อ่าน/แก้ไม่ได้ และไม่ต้องอ่าน
- Error: `PHONE_INVALID_FORMAT` · `OTP_INVALID` · `OTP_EXPIRED` · `OTP_ATTEMPTS_EXCEEDED` · `OTP_RATE_LIMITED`
  · `PHONE_ALREADY_IN_USE` (มีคนผูกเบอร์นี้สำเร็จระหว่างที่ผู้ใช้รอ SMS)

### 4.3 `signUpWithPhone` — สร้างบัญชี (public)

```graphql
input SignUpWithPhoneInput {
  verificationToken: String!
  role: Int!                         # 1 = ผู้สูงอายุ, 2 = ผู้ดูแล — เหมือน register
  consents: [ConsentAnswerInput!]    # ชุดเดียวกับ register (consentPolicy source: register)
}
type Mutation { signUpWithPhone(input: SignUpWithPhoneInput!): AuthPayload! }
```

```jsonc
// request
{ "variables": {
    "verificationToken": "v1.Zm9v…", "role": 1,
    "consents": [
      { "type": "terms_of_service", "granted": true, "policyVersion": "1.0" },
      { "type": "privacy_policy",   "granted": true, "policyVersion": "1.0" },
      { "type": "marketing",        "granted": false, "policyVersion": "1.0" } ] } }
// response — รูปเดียวกับ register
{ "data": { "signUpWithPhone": {
    "accessToken": "eyJ…", "refreshToken": "v1-abc…",
    "user": { "id": "a1b2…", "email": null, "phone": "0812345678", "role": 1 } } } }
```

- ความยินยอมตรวจ **ก่อน** อย่างอื่น ด้วยตัวตรวจเดียวกับ `register` → error `CONSENT_*` ชุดเดิม (FE map ไว้แล้วใน `consentRegisterError`)
- `role` นอกจาก 1, 2 → `BAD_REQUEST` (validation เดียวกับ `register`)
- `users` + `user_consents` + (role 2) `caregivers` สร้างในทรานแซคชันเดียว เหมือน `register`
- `displayName` เริ่มต้น = `null` (ไม่มีอีเมลให้ตัด prefix) — FE แสดงเบอร์แทนผ่าน `accountContact()` อยู่แล้ว
- Error: `PHONE_VERIFICATION_EXPIRED` (token หมดอายุ **หรือ** ถูกแก้/ปลอม — ทางแก้เดียวกันคือยืนยันเบอร์ใหม่ จึงใช้ code เดียว)
  · `PHONE_ALREADY_IN_USE` (คำขอสมัครเบอร์เดียวกันสองคำขอพร้อมกัน ได้บัญชีเดียว อีกคำขอได้ code นี้ · ใช้ token ซ้ำ)
  · `CONSENT_*`

### 4.4 `loginWithPhone` — ล็อกอิน (public)

```graphql
input LoginWithPhoneInput { phone: String!  code: String! }
type Mutation { loginWithPhone(input: LoginWithPhoneInput!): AuthPayload! }
```

```jsonc
{ "data": { "loginWithPhone": {
    "accessToken": "eyJ…", "refreshToken": "v1-abc…",
    "user": { "id": "a1b2…", "email": null, "role": 1, "isActive": true, "mustChangePassword": false, "phone": "0812345678" } } } }
```

- `AuthPayload` ตัวเดียวกับ `login` — มี `isActive`, `mustChangePassword` ครบ (FE ใช้ตรวจบัญชีถูกระงับ)
- เหมือน `login` อีเมล: **ไม่** ปฏิเสธบัญชีที่ `isActive = false` ที่ชั้นนี้ (FE ตรวจเองจาก `user.isActive`, guard ปฏิเสธทุก request ถัดไป)
- บันทึก `last_login_at` แบบเดียวกับ `login`
- Error: `PHONE_INVALID_FORMAT` · `OTP_INVALID` · `OTP_EXPIRED` · `OTP_ATTEMPTS_EXCEEDED` · `OTP_RATE_LIMITED` · `PHONE_NOT_REGISTERED`

### 4.5 `linkPhone` — ผูกเบอร์กับบัญชีที่ล็อกอินอยู่ (ต้องล็อกอิน)

```graphql
input LinkPhoneInput { phone: String!  code: String! }
type Mutation { linkPhone(input: LinkPhoneInput!): User! }
```

```jsonc
{ "data": { "linkPhone": { "id": "a1b2…", "phone": "0812345678", "phoneVerified": true } } }
```

- R6: ผูกกับบัญชีของ **ผู้ถือ session** เท่านั้น — ไม่มี `userId` ใน input · BE ตรวจว่าผู้ใช้ Supabase ที่ยืนยันรหัสได้คือคนเดียวกับผู้เรียก
- สำเร็จแล้ว BE เขียน `public.users.phone` = เบอร์ที่ผูก (รูปแบบ §3.2) → `me.phone` กับ `me.phoneVerified` ตรงกันทันที
- บัญชีที่ยืนยันเบอร์ไว้แล้วเรียกซ้ำด้วยเบอร์ใหม่ = เปลี่ยนเบอร์ล็อกอิน (Supabase รองรับ) — **ไม่มี UI ใน story นี้** (ไม่อยู่ในขอบเขต) FE ไม่เปิดให้ทำ
- Error: `UNAUTHENTICATED` · `PHONE_INVALID_FORMAT` · `OTP_INVALID` · `OTP_EXPIRED` · `OTP_ATTEMPTS_EXCEEDED` · `OTP_RATE_LIMITED`
  · `PHONE_ALREADY_IN_USE` (มีบัญชีอื่นผูกเบอร์นี้สำเร็จก่อน)

### 4.6 `User.phoneVerified` — field ใหม่

```graphql
type User {
  email: String              # ★ เดิม String! — บัญชีที่สมัครด้วยเบอร์ไม่มีอีเมล
  phone: String              # เดิมอยู่แล้ว — เบอร์ในโปรไฟล์ (§3.2)
  phoneVerified: Boolean!    # ★ ใหม่
  ...
}
```

- `true` เมื่อ **เบอร์ใน `phone` คือเบอร์ที่ยืนยันแล้วและใช้ล็อกอินได้** (`auth.users.phone_confirmed_at` มีค่า และเบอร์ตรงกับ `users.phone`)
- ผู้ใช้เดิมทุกคน = `false` (E1) จนกว่าจะผูกเบอร์
- ผู้ใช้ที่ยืนยันเบอร์แล้วไปแก้ `phone` ในโปรไฟล์เป็นเบอร์อื่นทีหลัง (ผ่าน `updateProfile`) → `false` เพราะเบอร์ที่แสดงไม่ใช่เบอร์ที่ยืนยัน
  (เบอร์ล็อกอินเดิมยังใช้ล็อกอินได้ — การเปลี่ยนเบอร์ล็อกอินไม่อยู่ในขอบเขตของ story)
- resolve แบบ lazy (`@ResolveField`) — query เพิ่มเฉพาะตอน client ขอ field นี้ ไม่กระทบ query อื่น
- อ่าน `auth.users` ไม่ได้ (เช่น DB ขัดข้องชั่วคราว) → ตอบ `false` ไม่ throw — field เป็น non-null ถ้า throw `me` ทั้งก้อนจะเป็น null
- FE แยกไว้ใน `MyPhoneStatus` แล้ว — **หลัง BE deploy แล้วย้ายเข้า `GET_USER` ได้** (ก่อนหน้านั้นห้าม — FE ระบุเหตุผลไว้ถูกต้อง)

---

## 5. Type อื่นที่เปลี่ยน (E13, E14)

| Type | Field | เดิม → ใหม่ | ใครใช้ |
|---|---|---|---|
| `User` | `email` | `String!` → `String` | ทุกหน้า |
| `User` | `phoneVerified` | — → `Boolean!` | หน้าตั้งค่าเบอร์ |
| `UserSummary` (`adminUserList.items`) | `email` | `String!` → `String` | แอดมิน |
| `UserSummary` | `phone` | — → `String` | ★ คำขอของ FE (คอมเมนต์ Wasan 14 ต.ค.) แยกบัญชีที่ไม่มีอีเมลในหน้าแอดมิน |
| `FamilyGroupMemberItem` | `email` | `String!` → `String` | กลุ่มครอบครัว (FE รองรับแล้ว) |
| `CaregiverKycSummary` | `email` | `String!` → `String` | คิว KYC แอดมิน (ผู้ดูแลสมัครด้วยเบอร์ได้) |
| `AdminUpdateCaregiverInfoPayload` | `email` | `String!` → `String` | แอดมินแก้ข้อมูลผู้ดูแล |
| `ProfilePhotoQueueItem` | `email` | `String!` → `String` | คิวรีวิวรูปโปรไฟล์ |
| `TransactionParty` | `email` | `String!` → `String` | รายการธุรกรรมแอดมิน |

- `adminUserList(search:)` ค้นจากเบอร์ในโปรไฟล์ได้ด้วย (เดิมค้นแค่ชื่อแสดงและอีเมล — บัญชีที่ไม่มีอีเมลจะหาไม่เจอ)
- ค่าที่เคยเป็นข้อความว่าง `""` เมื่อไม่มีอีเมล (`FamilyGroupMemberItem.email`, `CaregiverKycSummary.email`) เปลี่ยนเป็น `null` ให้ตรงกับ type
- **ไม่เปลี่ยน**: input ของ `login`, `register`, `requestPasswordReset`, `inviteAdmin` (S07-AC5 — operation อีเมลเดิมไม่เปลี่ยนทั้ง input และ response)
- E14 (client เก่า): การเปลี่ยน `String!` → `String` ไม่ทำให้ query เดิมพัง (GraphQL ยอม) แต่ client ที่ **อ่านค่า** แล้วเรียก
  method ของ string จะพังเมื่อเจอ `null` — FE แก้ทุกจุดที่แสดงอีเมลแล้วใน PR #31 (`accountContact()`) · ผู้ใช้เว็บได้ JS ชุดใหม่ทุกครั้งที่โหลดหน้า
  จึงไม่มี "client เวอร์ชันเก่า" ค้างนาน — แต่ **ต้อง deploy FE (#31) ก่อนเปิดให้สมัครด้วยเบอร์** (ดู §9)

---

## 6. Error contract

### 6.1 รูปแบบ — HTTP 200 + `extensions.code` (★ ไม่ใช่ 422)

```jsonc
// HTTP 200 · content-type ตามที่ Apollo Server ตอบปกติ
{ "data": null,
  "errors": [{
    "message": "ขอรหัสบ่อยเกินไป กรุณารอ 42 วินาทีแล้วลองใหม่",
    "path": ["requestPhoneOtp"],
    "extensions": { "code": "OTP_RATE_LIMITED", "resendAfterSeconds": 42 } }] }
```

ทำไมไม่ใช่ 422:
- error ของ business rule ทุกตัวใน GraphQL ของ repo นี้ (`CONSENT_*`, `FamilyGroupError`, `ONBOARDING_REQUIRED`, `FIELD_LOCKED`) เป็น
  `GraphQLError` ที่มี `extensions.code` → Apollo Server ตอบ **HTTP 200** · 422 ใช้เฉพาะ REST (`UnprocessableEntityException` ใน `booking`, `dispute`)
- ถ้าโยน `UnprocessableEntityException` ใน GraphQL, code ของเราจะ **หาย** (ไปอยู่ใน `originalError` ไม่ใช่ `extensions.code` — ดูคำอธิบายใน `src/consent/consent.errors.ts`)
- ผลต่อ FE: ได้ `CombinedGraphQLErrors` ตรง ๆ → `extractGraphQLErrorExtensions()` อ่าน code ได้เลย ทางสำรองที่อ่าน body ของ `ServerError` ยังเก็บไว้ได้ไม่เสียหาย

ข้อความ (`message`): ภาษาไทย บอกว่าผิดที่ใดและต้องทำอะไรต่อ (R9) — **FE ไม่ต้องใช้** (FE แสดงข้อความของตัวเองตาม code, TH/EN จาก `phoneAuthStrings`)
และไม่มีรหัส OTP, token, หรือเบอร์เต็มอยู่ใน message ใดเลย (R10)

### 6.2 รายการ code

| code | เกิดที่ | ความหมาย / ผู้ใช้ต้องทำอะไรต่อ | ข้อมูลใน `extensions` |
|---|---|---|---|
| `PHONE_INVALID_FORMAT` | ทุกตัวที่รับ `phone` | ไม่ใช่มือถือไทย 10 หลัก 06/08/09 — แก้เบอร์ | — |
| `PHONE_ALREADY_IN_USE` | request(SIGNUP, LINK) · verify · signUp · link | เบอร์เป็นของบัญชีอื่นแล้ว — สมัคร: ไปล็อกอิน · ผูก: ใช้เบอร์อื่น | — |
| `PHONE_NOT_REGISTERED` | request(LOGIN) · loginWithPhone | ไม่มีบัญชีที่ใช้เบอร์นี้ล็อกอิน — ไปสมัคร | — |
| `PHONE_NOT_VERIFIED` | request(LOGIN) | มีบัญชีที่กรอกเบอร์นี้ไว้แต่ยังไม่ยืนยัน — ล็อกอินด้วยอีเมลแล้วผูกเบอร์ (E1) | — |
| `OTP_INVALID` | verify · login · link | รหัสผิด / เป็นรหัสเก่าก่อนขอใหม่ (E8) / ไม่มีรหัสค้างอยู่ — กรอกใหม่ | — |
| `OTP_EXPIRED` | verify · login · link | รหัสหมดอายุ — ขอรหัสใหม่ (E7) | — |
| `OTP_ATTEMPTS_EXCEEDED` | verify · login · link | กรอกผิดครบจำนวนแล้ว รหัสนี้ใช้ไม่ได้อีกแม้กรอกถูก — ขอรหัสใหม่ (E9) | — |
| `OTP_RATE_LIMITED` | requestPhoneOtp (และ verify ถ้า Supabase จำกัด) | ขอ/ลองถี่เกิน — รอแล้วลองใหม่ (E10) | `resendAfterSeconds: Int` (≥ 1) |
| `SMS_SEND_FAILED` | requestPhoneOtp | ส่ง SMS ไม่สำเร็จ — ลองใหม่ภายหลัง ไม่นับเป็นการกรอกผิด (E11) | — |
| `PHONE_VERIFICATION_EXPIRED` | signUpWithPhone | token หมดอายุ/ใช้ไม่ได้ — กลับไปยืนยันเบอร์ใหม่ (เบอร์เดิมยังอยู่) | — |
| `CONSENT_*` | signUpWithPhone | ชุดเดิมของ PYG-474 | ตาม `consent.errors.ts` |
| `UNAUTHENTICATED` / `FORBIDDEN` | request(LINK) · linkPhone | ไม่ได้ล็อกอิน / บัญชีถูกระงับ | — |
| `BAD_USER_INPUT` | verifyPhoneOtp | `purpose` ไม่ใช่ `SIGNUP` (FE ไม่เคยส่ง) | — |
| `INTERNAL_SERVER_ERROR` | verify · login · link · signUp | Supabase ขัดข้อง/หมดเวลาระหว่างตรวจรหัสหรือออก session — ลองใหม่ **ไม่นับเป็นการกรอกผิด** (E11) · FE แสดงข้อความกลาง | — |

- **code ทุกตัวตรงกับ `PHONE_AUTH_ERROR` ของ FE** (`src/graphql/phoneAuth.ts`) — ไม่มี code ใหม่ที่ FE ไม่รู้จัก
- OTP_INVALID vs OTP_EXPIRED: Supabase ตอบ `otp_expired` เหมือนกันทั้งสองกรณี BE จึงแยกจากเวลาที่ส่งรหัสที่ BE จำไว้เอง
  ถ้า BE ไม่รู้เวลาส่ง (เช่น เซิร์ฟเวอร์ restart ระหว่างรอ) จะตอบ `OTP_INVALID` — ผู้ใช้กดขอรหัสใหม่ได้ตามปกติ

---

## 7. ค่าที่ตั้งได้ (R8) — env ของ BE

| env | ค่าเริ่มต้น | ความหมาย | ต้องตรงกับ |
|---|---|---|---|
| `PHONE_OTP_EXPIRES_SECONDS` | `60` | อายุรหัส → `expiresInSeconds` และใช้แยก OTP_EXPIRED | ★ **Supabase Dashboard → Auth → Providers → Phone → "SMS OTP Expiry"** (ค่าเริ่มต้นของ Supabase = 60) |
| `PHONE_OTP_RESEND_COOLDOWN_SECONDS` | `60` | ระยะห่างขั้นต่ำระหว่างการขอรหัสของเบอร์เดียวกัน → `resendAfterSeconds` | ต้อง **≥** ระยะห่างของ Supabase (ค่าเริ่มต้น 60) ไม่งั้นผู้ใช้จะเจอ Supabase ปฏิเสธเอง |
| `PHONE_OTP_MAX_ATTEMPTS` | `5` | กรอกผิดได้กี่ครั้งต่อรหัส 1 ชุด | — |
| `PHONE_OTP_MAX_SENDS_PER_PHONE_PER_DAY` | `10` | ส่ง SMS ไปเบอร์เดียวได้กี่ครั้งใน 24 ชม. | — |
| `PHONE_OTP_MAX_SENDS_PER_IP_PER_HOUR` | `20` | ขอรหัสจาก IP เดียวได้กี่ครั้งใน 1 ชม. (กันยิงหลายเบอร์จนเปลืองค่า SMS) | — |
| `PHONE_VERIFICATION_TOKEN_TTL_SECONDS` | `1800` | อายุ `verificationToken` (เวลาอ่านเงื่อนไข) | — |
| `PHONE_VERIFICATION_TOKEN_SECRET` | — (dev สุ่มให้ชั่วคราว) | กุญแจเข้ารหัส `verificationToken` ยาว ≥ 32 ตัวอักษร | production **ต้องตั้ง** — ไม่ตั้งแล้วเฉพาะ `verifyPhoneOtp`/`signUpWithPhone` ใช้ไม่ได้ (แอปยังบูตปกติ) |

ตัวเลขทั้งหมด **ยังไม่ได้เคาะ** (ประเด็น R8 ของ story) — ค่าเริ่มต้นเลือกให้ตรงกับค่าเริ่มต้นของ Supabase และการ์ด (60 วินาที, OTP 6 หลัก)
เปลี่ยนได้ทาง env โดยไม่แก้โค้ด · จำนวนหลักของรหัสตั้งที่ Supabase ("SMS OTP Length" = 6) — FE ใช้ 6 หลักอยู่

⚠ ตัวนับ rate limit และครั้งที่กรอกผิดอยู่ในหน่วยความจำ (แบบเดียวกับ `SlidingWindowRateLimiter` ของ PYG-479) — restart แล้วเริ่มนับใหม่
และถ้าวันหนึ่งรันหลาย instance ต้องย้ายไป Redis · Supabase มี rate limit ของตัวเองซ้อนอีกชั้น (Dashboard → Auth → Rate Limits)

---

## 8. ความปลอดภัย

- **R10**: ไม่มีรหัส OTP ใน response, error, หรือ log · BE log เบอร์แบบปิดบัง (`081XXX5678`) ไม่ log เบอร์เต็ม · ไม่เก็บรหัสในดีบีของเรา (Supabase เก็บเป็น hash)
- **R6**: `linkPhone` ผูกกับผู้ถือ session เท่านั้น — ตรวจว่า user ที่ Supabase คืนมาหลังยืนยันรหัสคือคนเดียวกับผู้เรียก
- `verificationToken` เข้ารหัสแบบ AES-256-GCM (แก้ไขแล้วถอดไม่ได้) มีวันหมดอายุในตัว และใช้สร้างบัญชีได้ครั้งเดียว
- Session ของการสมัครออกให้ **หลัง** สร้างแถว `public.users` สำเร็จเท่านั้น — ระหว่างอ่านเงื่อนไขผู้ใช้ไม่มี session
- การจำกัด: ต่อเบอร์ (ระยะห่าง + ต่อวัน) และต่อ IP · ครั้งที่ถูกปฏิเสธไม่ถูกนับ (เวลาที่บอกให้รอเป็นเวลาจริง แบบ PYG-479)
- กันคำขอซ้ำที่ BE ด้วย (คำขอของเบอร์เดียวกันที่ยังไม่จบ → ปฏิเสธ) — FE กันฝั่งตัวเองแล้ว แต่ BE ไม่พึ่ง FE

---

## 9. ลำดับ deploy และการตั้งค่า Supabase

1. **Supabase Dashboard** (Sammy — production เป็น branch เดียว):
   - Auth → Providers → **Phone: เปิด** · เลือกผู้ให้บริการ SMS + ใส่คีย์ (ไม่อยู่ใน repo)
   - "SMS OTP Expiry" = ค่าเดียวกับ `PHONE_OTP_EXPIRES_SECONDS` · "SMS OTP Length" = 6
   - SMS template ภาษาไทย เช่น `รหัสยืนยัน Payung: {{ .Code }} ห้ามบอกรหัสนี้กับผู้อื่น`
   - **Test Phone Numbers and OTPs** สำหรับ dev/QA — เบอร์ทดสอบที่มีรหัสตายตัว **ไม่ส่ง SMS จริง ไม่เสียเงิน** (นี่คือ "ตัวปลอมสำหรับ dev" ของการ์ด)
2. Env ของ BE ตาม §7 (อย่างน้อย `PHONE_VERIFICATION_TOKEN_SECRET`)
3. FE PR #31 (แสดงผลเมื่อไม่มีอีเมล) อยู่ใน dev แล้ว ✔
4. BE PYG-603 + migration PYG-602 (PR #107) — **PR เดียวกัน** ตามมติ · Sammy รัน `prisma migrate deploy`
5. ตรวจ: ล็อกอินด้วยอีเมลของบัญชีทดสอบยังได้ (S07-AC5)
6. FE ตั้ง `VITE_PHONE_AUTH_ENABLED=true`

---

## 10. ประเด็นที่ยังเปิดอยู่ (ไม่บล็อกโค้ด แต่ต้องมีคนตัดสิน)

1. **ผู้ให้บริการ SMS / ใครจ่าย / งบต่อเดือน** — ไม่บล็อกโค้ด แต่บล็อกการเปิดใช้จริง (production ต้องมีผู้ให้บริการ) · ผู้ตัดสิน: PO/Sammy
2. **ตัวเลข R8** — ใช้ค่าเริ่มต้นใน §7 ไปก่อน
3. **E6** — ตอนนี้บอกตรง ๆ (`PHONE_NOT_REGISTERED`) ตาม Design ถ้าเคาะให้ตอบเหมือนกันทุกกรณี: BE แก้จุดเดียว FE ไม่ต้องแก้ (FE ยืนยันไว้แล้ว)
4. **แอดมิน** — contract ไม่บล็อกแอดมิน (Supabase ไม่แยก role) แต่ FE เปิดหน้าผูกเบอร์ให้ role 1, 2 เท่านั้น · แอดมินถูกเชิญด้วยอีเมลจึงมีอีเมลเสมอ
5. **E13 อีเมล/ใบเสร็จของบัญชีที่ไม่มีอีเมล** — PYG-603 ทำให้ "ไม่พัง" (ข้ามการส่งอีเมล + log) ส่วนการส่งทางช่องทางอื่น (SMS) ไม่อยู่ในขอบเขต
   · Omise (ตรวจโค้ดแล้ว): การ **ชำระเงิน** ของผู้สูงอายุไม่ส่งอีเมลให้ Omise จึงไม่กระทบ · แต่การสร้าง **บัญชีรับเงินของผู้ดูแล**
     (`OmiseService.createRecipient`) ส่ง `email` ไปด้วย — PYG-603 ไม่ส่งช่องนี้เมื่อผู้ดูแลไม่มีอีเมล ตามเอกสาร API ของ Omise
     `email` ของ recipient ไม่บังคับ แต่ **ยังไม่ได้ลองกับ Omise test key** ต้องยืนยันก่อนเปิดให้ผู้ดูแลสมัครด้วยเบอร์
6. **เบอร์ซ้ำ 13 บัญชีใน `public.users.phone`** — ไม่กระทบการล็อกอิน (ล็อกอินหาจาก `auth.users`) แต่ถ้าบัญชีเหล่านั้นมาผูกเบอร์ คนแรกที่ผูกได้เบอร์ไป คนถัดไปได้ `PHONE_ALREADY_IN_USE`
7. **บัญชีที่สมัครด้วยเบอร์อย่างเดียวแล้วทำซิมหาย** — ไม่อยู่ในขอบเขต · ช่วง Pilot แอดมินช่วยได้โดยแก้ `auth.users.phone` ผ่าน Supabase Dashboard
8. **ผู้ใช้เดิมที่มีเบอร์ในโปรไฟล์** — จะชวนให้ยืนยันเบอร์ที่ใด: FE เติมเบอร์เดิมให้ในหน้าตั้งค่าแล้ว (`phoneHintLinkExisting`) ส่วนการชวนเชิงรุกไม่อยู่ใน contract นี้
9. **เบอร์ที่มีคนเริ่มสมัครแล้วทิ้งไว้ (พบตอนเขียน PYG-603)** — Supabase สร้างผู้ใช้ไว้ตั้งแต่ขอรหัสสมัคร ถ้าเจ้าของเบอร์ไม่สมัครต่อ
   แล้วไปสมัครด้วยอีเมลแทน จะ **ผูกเบอร์นั้นไม่ได้** (`PHONE_ALREADY_IN_USE` — Supabase บังคับเบอร์ไม่ซ้ำรวมผู้ใช้ที่ทิ้งไว้)
   แต่ **สมัครด้วยเบอร์นั้นต่อได้ตามปกติ** · ไม่ได้ให้ BE ลบผู้ใช้ Supabase ที่ทิ้งไว้เองอัตโนมัติ เพราะการลบเกิดก่อนพิสูจน์ความเป็นเจ้าของเบอร์
   (คนอื่นสั่งลบการสมัครที่กำลังทำอยู่ของเจ้าของเบอร์ได้) · ช่วง Pilot แอดมินลบผู้ใช้ Supabase ที่ไม่มีแถวใน `public.users` ให้ได้ถ้ามีคนแจ้ง
10. **บัญชีที่ยืนยันเบอร์แล้วเรียก `linkPhone` ด้วยเบอร์ใหม่** — Supabase เปลี่ยนเบอร์ล็อกอินให้ (contract §4.5) ไม่มี UI ใน story นี้
    ถ้าทีมต้องการ "ห้ามเปลี่ยน" ให้เพิ่มการตรวจใน PYG-603 ได้จุดเดียว

---

## 11. ตอบคำขอของ FE (ส่วน "เพิ่มเติมจากฝั่ง FE" ในการ์ด)

| คำขอ | คำตอบ |
|---|---|
| เพิ่ม `verifyPhoneOtp` + `signUpWithPhone` รับ token | ✅ รับตามที่ขอ (§4.2, §4.3) · token หมดอายุ → `PHONE_VERIFICATION_EXPIRED` |
| เวลาเป็นวินาที | ✅ `resendAfterSeconds`, `expiresInSeconds` เป็น `Int!` วินาที |
| `loginWithPhone.user` ต้องมี `isActive`, `mustChangePassword` | ✅ เป็น `AuthPayload.user` = `User` เต็มตัว |
| `role` + `consents` เหมือน `register` และตอบ `CONSENT_*` | ✅ ใช้ตัวตรวจเดียวกัน |
| ระบุ status และ content-type ของ business error | ✅ HTTP 200 + `extensions.code` (§6.1) |
| `OTP_RATE_LIMITED` มี `extensions.resendAfterSeconds` | ✅ จำนวนเต็มวินาที ≥ 1 |
| `PHONE_ALREADY_IN_USE` ตอนขอรหัสหรือตอนยืนยัน | ✅ ตอบตอนขอรหัสเป็นหลัก (ไม่เสียค่า SMS) และตอนยืนยัน/สร้างบัญชีสำหรับกรณีแข่งกัน |
| BE กันคำขอซ้ำเอง | ✅ (§8) |
| `UserSummary.phone` + `email` nullable | ✅ (§5) |
| `FamilyGroupMember.email` nullable | ✅ `FamilyGroupMemberItem.email` (§5) |
| `phoneVerified` ใน query แยก | ✅ ถูกต้อง — ย้ายเข้า `GET_USER` ได้หลัง BE deploy |
| เบอร์มือถือไทยเท่านั้น 06/08/09 | ✅ กฎเดียวกัน (§3.1) · เบอร์ต่างประเทศไม่รับ |
| ค่า `phone` ที่ตอบกลับ | คืน `0812345678` ไม่ใช่ E.164 (§3.2) — `nationalDigits()` รองรับอยู่แล้ว FE ไม่ต้องแก้ |
