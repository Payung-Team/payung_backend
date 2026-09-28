import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { MemberDetailsInput } from './create-booking-on-behalf.input';
import {
  ALLERGIES_MAX_LENGTH,
  MEDICINES_MAX_LENGTH,
} from '../../patient/dto/patient-profile.constants';

/**
 * PYG-464 follow-up — QA PYG-427 TC-BS-03/06 (PYG-427_32) พบว่าเพดานความยาวของ
 * medicines/allergies ระหว่าง "จองแทน" (MemberDetailsInput) กับ "จองปกติ"
 * (PatientProfileDto) ไม่ตรงกัน (1000 vs 2000) ทั้งที่เขียนลงคอลัมน์เดียวกัน
 *
 * เทสนี้ล็อกว่า MemberDetailsInput ต้องรับได้ถึง 2000 ตัวอักษรเท่า PatientProfileDto
 * เพื่อกันไม่ให้ตัวเลขเหลื่อมกันอีกในอนาคต
 */
describe('MemberDetailsInput — เพดานความยาว medicines/allergies (PYG-464 follow-up)', () => {
  it('รับ medicines ยาว 2000 ตัวอักษรได้ (เดิมเพดานอยู่ที่ 1000 จะตกตรงนี้)', async () => {
    const input = plainToInstance(MemberDetailsInput, {
      medicines: 'ก'.repeat(MEDICINES_MAX_LENGTH),
    });
    const errors = await validate(input);
    expect(errors).toHaveLength(0);
  });

  it('ปฏิเสธ medicines ที่ยาวเกิน 2000 ตัวอักษร', async () => {
    const input = plainToInstance(MemberDetailsInput, {
      medicines: 'ก'.repeat(MEDICINES_MAX_LENGTH + 1),
    });
    const errors = await validate(input);
    expect(errors.some((e) => e.property === 'medicines')).toBe(true);
  });

  it('รับ allergies ยาว 2000 ตัวอักษรได้ (เดิมเพดานอยู่ที่ 1000 จะตกตรงนี้)', async () => {
    const input = plainToInstance(MemberDetailsInput, {
      allergies: 'ก'.repeat(ALLERGIES_MAX_LENGTH),
    });
    const errors = await validate(input);
    expect(errors).toHaveLength(0);
  });

  it('ปฏิเสธ allergies ที่ยาวเกิน 2000 ตัวอักษร', async () => {
    const input = plainToInstance(MemberDetailsInput, {
      allergies: 'ก'.repeat(ALLERGIES_MAX_LENGTH + 1),
    });
    const errors = await validate(input);
    expect(errors.some((e) => e.property === 'allergies')).toBe(true);
  });
});
