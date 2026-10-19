/**
 * PYG-464 follow-up (พบตอน QA ของ PYG-427 TC-BS-03/06, PYG-427_32) — เพดานความยาวของ
 * medicines/allergies ต้องเท่ากันทั้งสองเส้นทางที่เขียนคอลัมน์ bookings.member_details
 * (JSONB) เดียวกัน และรูปแบบ/ชื่อฟิลด์ตรงกันเป๊ะ:
 *   ① จองแทนในกลุ่ม (CreateBookingOnBehalfInput → MemberDetailsInput)
 *   ② จองปกติ (CreateBookingDto.patientProfile → PatientProfileDto)
 *
 * ก่อนหน้านี้ ① ใช้ 1000 ส่วน ② ใช้ 2000 — ข้อมูลชุดเดียวกัน (1001–2000 ตัวอักษร)
 * จึงผ่าน validation ทาง ② แต่ตกทาง ① ทั้งที่ควรผ่านเหมือนกัน
 *
 * ทั้งสองไฟล์ต้อง import ค่าจากที่นี่ ห้ามฮาร์ดโค้ดตัวเลขซ้ำ ไม่งั้นจะเหลื่อมกันอีก
 */
export const MEDICINES_MAX_LENGTH = 2000;
export const ALLERGIES_MAX_LENGTH = 2000;
