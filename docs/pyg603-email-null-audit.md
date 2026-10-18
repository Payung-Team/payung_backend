# PYG-603 — รายการจุดที่อ่านหรือส่งอีเมลของผู้ใช้ (E13 ของ PYG-562)

> DoD ของ PYG-603: "รายการจุดที่อ่านหรือส่งอีเมลของผู้ใช้ แนบในการ์ดพร้อมสถานะว่าแก้แล้วหรือรอเคาะ"
> ตรวจบน branch `feature/pyg-603` (= `dev` @ `3eeceb8` + migration PYG-602 จาก PR #107) วันที่ 2026-10-16

## วิธีหา

1. **ตัว compiler** — เปลี่ยน `User.email` เป็น `String?` (migration ของ PYG-602) แล้ว `tsc` ชี้ได้ **37 จุดใน 10 ไฟล์**
   (ตรงกับที่ PR #107 คาดไว้ทุกจุด) → แก้ครบ `tsc` = 0
2. **จุดที่ compiler มองไม่เห็น** — โค้ดที่ประกาศ type ของแถวเอง (`email: string`) หรือแปลง null เป็น `''`
   จะผ่าน `tsc` แต่ **พังตอนรันจริง** เมื่อส่ง `null` เข้า GraphQL field ที่เป็น `String!` (ทั้ง query ของหน้านั้นพัง)
   → ค้นด้วย `grep` + ตรวจ `src/schema.gql` ว่า output type ไหนยังมี `email: String!` พบเพิ่ม **3 จุด**

กติกาที่ใช้ทุกจุด: **ไม่มีอีเมล = ข้ามการส่ง + log `no_email` ไม่ throw** (แบบเดียวกับคนที่ปิดรับอีเมล)
ผู้ใช้ยังได้แจ้งเตือนในแอปตามปกติ — การส่งทาง SMS แทนอีเมล **ไม่อยู่ในขอบเขต** (รอผลเคาะของ story)

## จุดที่ "ส่งอีเมล" — ต้องตัดสินพฤติกรรม ไม่ใช่แค่แก้ type

| จุด | ทำอะไร | ผู้รับ | สถานะ |
|---|---|---|---|
| `EmailService.fetchUser` (ทุกอีเมลแจ้งเตือน: KYC, booking lifecycle, dispute ฯลฯ) | ส่งอีเมลแจ้งเตือน | ผู้ใช้ทุก role | ✅ ไม่มีอีเมล → ข้าม + log `email.skipped reason=no_email` |
| `EmailService.sendMarketingEmail` | อีเมลข่าวสาร (PYG-540) | ผู้ใช้ | ✅ ไม่มีอีเมล → `false` (skip `no_email`) |
| `UserCleanupService.deleteUser` ขั้น 4 | อีเมลแจ้ง "บัญชีถูกลบถาวร" | ผู้ใช้ | ✅ ไม่มีอีเมล → ข้ามขั้นนี้ (ลบบัญชีครบแล้ว) |
| `AdminCleanupService.deleteAdmin` ขั้น 4 | อีเมลแจ้งแอดมินถูกลบ | แอดมิน | ✅ กันไว้เหมือนกัน (แอดมินมีอีเมลเสมอ) |
| `AdminService.inviteAdmin` | อีเมลเชิญ + รหัสชั่วคราว | แอดมินใหม่ | ✅ ใช้ `input.email` ที่เพิ่งเชิญ (มีค่าเสมอ) |
| `AdminService.toggleAdminStatus` / `scheduleDeleteAdmin` / `cancelScheduledDelete` | อีเมลแจ้งสถานะแอดมิน | แอดมิน | ✅ ไม่มีอีเมล → ข้าม |
| `ReconciliationCron` | อีเมลแจ้งเตือนความผิดปกติทางการเงิน | แอดมิน | ✅ กรองที่อยู่ว่างออก (type guard) |
| `OmiseService.createRecipient` ← `PayoutAccountService` ← `approveKyc` / `updatePayoutAccount` | ส่งอีเมลผู้ดูแลให้ Omise ตอนสร้างบัญชีรับเงิน | Omise | ✅ ไม่มีอีเมล → **ไม่ส่งช่อง `email`** · ⚠️ **รอยืนยันกับ Omise test key** ว่า Omise รับ recipient ที่ไม่มีอีเมล (ตามเอกสาร API ไม่บังคับ) ก่อนเปิดให้ผู้ดูแลสมัครด้วยเบอร์ |
| การชำระเงินของผู้สูงอายุ (Omise charge) | — | — | ✅ ตรวจแล้ว **ไม่ส่งอีเมลให้ Omise** ไม่กระทบ |

## จุดที่ "อ่านอีเมล" แล้วอาจพัง

| จุด | ปัญหาเดิมเมื่ออีเมลเป็น null | สถานะ |
|---|---|---|
| `UserService.completeOnboarding` | `user.email.split('@')` → **500** ตอนผู้สูงอายุที่สมัครด้วยเบอร์กดบันทึกหน้า Onboarding | ✅ แก้ด้วย `isSystemDefaultDisplayName()` (null = ยังไม่เคยตั้งชื่อ → ทับด้วยชื่อจริงได้) |
| `SupabaseAuthGuard` / `AuthUser.email` | type บอกว่ามีอีเมลเสมอ | ✅ `string \| null` |
| `UserService.mapToEntity`, `AuthService.login/register/confirmOAuthRole`, `AdminService.mapToUser/mapToCaregiver` | type | ✅ `string \| null` |
| `DisputeService.toPartyBrief` | type | ✅ null → `undefined` (field เป็น nullable อยู่แล้ว) |
| `AdminProfilePhotoService` (คิวรูป + รายละเอียด) | type + output `String!` | ✅ |
| ★ `TransactionService` (หน้ารายการธุรกรรมแอดมิน) | **tsc มองไม่เห็น** — ประกาศ row type เอง `email: string` → null เข้า `TransactionParty.email: String!` = ทั้งหน้าพัง | ✅ type + output nullable |
| ★ `FamilyGroupService.toMemberItem` | **tsc มองไม่เห็น** — แปลง null เป็น `''` | ✅ คืน `null` + output nullable (FE PR #31 รองรับแล้ว) |
| ★ `AdminService.adminKycList` | **tsc มองไม่เห็น** — แปลง null เป็น `''` | ✅ คืน `null` + output nullable |

## Output type ของ GraphQL ที่เปลี่ยน `email: String!` → `String`

`User` · `UserSummary` (+ เพิ่ม `phone`) · `FamilyGroupMemberItem` · `CaregiverKycSummary` · `AdminUpdateCaregiverInfoPayload` ·
`ProfilePhotoQueueItem` · `TransactionParty` — รายละเอียดใน contract PYG-601 §5

## ที่ไม่ได้แก้ (ตั้งใจ)

- `src/identity/models/user.model.ts` — `User` ตัวเก่าที่ไม่มีใคร import แล้ว (ไม่อยู่ใน schema) · เป็นโค้ดตาย ไม่ใช่ขอบเขตของการ์ดนี้
- log ที่พิมพ์อีเมลอยู่แล้วใน `user-cleanup` / `admin-cleanup` (ของเดิม) — พิมพ์ `null` ได้ไม่พัง · เรื่อง PII ใน log เป็นงานแยก

## เทสที่คุมจุดเหล่านี้

- `src/email/email.service.spec.ts` — ไม่มีอีเมล → ข้ามทั้งแจ้งเตือนและข่าวสาร · มีอีเมลยังได้ตามเดิม
- `src/payment/omise/omise.service.recipient-transfer.spec.ts` — ไม่มีอีเมล → ไม่ส่งช่อง `email`
- `src/identity/auth/user.service.display-name.spec.ts` — Onboarding ของบัญชีที่ไม่มีอีเมล
