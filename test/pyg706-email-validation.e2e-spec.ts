/**
 * PYG-706 · [Check] Email format validation — ฝั่ง BE
 *
 * ยิง DTO จริงทั้ง 7 ตัวที่รับอีเมลผ่าน ValidationPipe ตั้งค่าเดียวกับ src/main.ts
 * (transform + whitelist + forbidNonWhitelisted) → ค่าที่ไม่ผ่านต้องได้ BadRequestException (400) ก่อนถึง service
 * ไม่ต้องใช้ DB · TC_NO = PYG-706_NN · รายงาน: docs/qa/pyg-706-email-validation-report.md
 *
 * expected มาจากรายการในการ์ด PYG-706 (ไม่ใช่จาก validator)
 * PYG-707 แก้แล้ว: กติกาเดียว @ValidAppEmail() — ตัดช่องว่าง/อักขระซ่อนหัวท้าย + ตัวเล็ก ก่อนตรวจ
 */
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { EMAIL_FORMAT_MESSAGE } from '../src/common/validators/valid-app-email.validator';
import { InviteAdminInput } from '../src/admin/dto/invite-admin.input';
import { AdminEditUserInput } from '../src/admin/dto/admin-edit-user.input';
import { EditAdminInfoInput } from '../src/admin/dto/edit-admin-info.input';
import { AdminUpdateCaregiverInfoInput } from '../src/admin/dto/admin-update-caregiver-info.input';
import { LoginInput } from '../src/identity/auth/dto/login.input';
import { RegisterInput } from '../src/identity/auth/dto/register.input';
import { RequestPasswordResetInput } from '../src/identity/auth/dto/request-password-reset.input';

const UUID = '3f8b2c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';

/** ค่าที่ถูกต้องของช่องอื่น — ให้เหลือแค่อีเมลเป็นตัวแปร */
const DTOS: [string, new () => object, Record<string, unknown>][] = [
  ['RegisterInput', RegisterInput, { password: 'Passw0rd!', role: 1 }],
  ['LoginInput', LoginInput, { password: 'Passw0rd!' }],
  ['RequestPasswordResetInput', RequestPasswordResetInput, {}],
  [
    'InviteAdminInput',
    InviteAdminInput,
    { firstName: 'QA', lastName: 'Admin', role: 3 },
  ],
  ['AdminEditUserInput', AdminEditUserInput, { userId: UUID }],
  ['EditAdminInfoInput', EditAdminInfoInput, { adminId: UUID }],
  [
    'AdminUpdateCaregiverInfoInput',
    AdminUpdateCaregiverInfoInput,
    { caregiverId: UUID },
  ],
];

const pipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
});

/** ผ่าน → { email ที่ normalize แล้ว } · ไม่ผ่าน → { errors } */
async function check(
  metatype: new () => object,
  rest: Record<string, unknown>,
  email: string,
): Promise<{ email?: string; errors?: string[] }> {
  try {
    const out = (await pipe.transform(
      { ...rest, email },
      { type: 'body', metatype },
    )) as { email: string };
    return { email: out.email };
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    expect((e as BadRequestException).getStatus()).toBe(400);
    return {
      errors: (
        (e as BadRequestException).getResponse() as { message: string[] }
      ).message,
    };
  }
}

/** อีเมลยาว n ตัวอักษร โครงถูกต้อง (local 64 · label ≤ 63) */
function emailOfLength(n: number): string {
  const local = 'a'.repeat(64);
  let rest = n - 65 - 4;
  const labels: string[] = [];
  while (rest > 0) {
    const l = Math.min(63, rest);
    labels.push('b'.repeat(l));
    rest -= l + 1;
  }
  return `${local}@${labels.join('.')}.com`;
}

/** [TC, ค่าที่ส่ง, ค่าที่ระบบเก็บหลัง normalize] */
const VALID: [string, string, string][] = [
  ['PYG-706_01', 'user@example.com', 'user@example.com'],
  ['PYG-706_02', 'user.name@example.co.th', 'user.name@example.co.th'],
  ['PYG-706_03', 'user+tag@example.com', 'user+tag@example.com'],
  ['PYG-706_04', 'user_name123@sub.domain.com', 'user_name123@sub.domain.com'],
  ['PYG-706_05', 'User@Example.COM', 'user@example.com'],
  ['PYG-706_06', emailOfLength(254), emailOfLength(254)],
  // edge: copy-paste — ตัดหัวท้ายให้ (การ์ด: "ควร trim หรือแจ้ง error")
  ['PYG-706_18', ' user@example.com', 'user@example.com'],
  ['PYG-706_19', 'user@example.com ', 'user@example.com'],
  ['PYG-706_20', 'user@example.com ', 'user@example.com'],
  ['PYG-706_24', 'user@example.com​', 'user@example.com'],
  ['PYG-706_25', '﻿user@example.com', 'user@example.com'],
];

const INVALID: [string, string, string][] = [
  ['PYG-706_07', 'ไม่มี @', 'userexample.com'],
  ['PYG-706_08', 'ไม่มี domain', 'user@'],
  ['PYG-706_09', 'ไม่มี local part', '@example.com'],
  ['PYG-706_10', 'ไม่มี TLD', 'user@example'],
  ['PYG-706_11', '@ สองตัว', 'user@@example.com'],
  ['PYG-706_12', 'มีช่องว่าง', 'user name@example.com'],
  ['PYG-706_13', 'จุดติดกัน', 'user..name@example.com'],
  ['PYG-706_14', 'ขึ้นต้นด้วยจุด', '.user@example.com'],
  ['PYG-706_15', 'ลงท้าย local ด้วยจุด', 'user.@example.com'],
  ['PYG-706_16', 'ค่าว่าง', ''],
  ['PYG-706_17', 'ยาว 255 ตัวอักษร', emailOfLength(255)],
  ['PYG-706_21', 'ตัวอักษร !#', 'user!#@example.com'],
  ['PYG-706_22', 'ภาษาไทยใน local part', 'ผู้ใช้@example.com'],
  ['PYG-706_23', 'ภาษาไทยใน domain', 'user@ตัวอย่าง.com'],
  ['PYG-706_28', 'zero-width space ข้างใน', 'us​er@example.com'],
  ['PYG-706_29', 'domain จุดติดกัน', 'user@example..com'],
  ['PYG-706_30', 'IP แทน domain', 'user@[192.168.0.1]'],
  [
    'PYG-706_31',
    'ขึ้นบรรทัดใหม่ (header injection)',
    'user@example.com\nbcc@evil.com',
  ],
];

describe.each(DTOS)('PYG-706 · %s', (_name, metatype, rest) => {
  it.each(VALID)(
    '%s Verify that %j is accepted and stored as %j',
    async (_tc, email, stored) => {
      expect(await check(metatype, rest, email)).toEqual({ email: stored });
    },
  );

  it.each(INVALID)(
    '%s Verify that an email with %s is rejected with 400 and the shared message',
    async (_tc, _what, email) => {
      const { errors } = await check(metatype, rest, email);
      expect(errors).toContain(EMAIL_FORMAT_MESSAGE);
    },
  );
});

describe('PYG-706 · ข้อความ error', () => {
  it('PYG-706_27 Verify that every DTO returns one Thai email error message', async () => {
    const messages = new Set<string>();
    for (const [, metatype, rest] of DTOS) {
      const { errors } = await check(metatype, rest, 'userexample.com');
      messages.add(errors!.find((m) => /อีเมล|email/i.test(m))!);
    }
    expect([...messages]).toEqual([EMAIL_FORMAT_MESSAGE]);
    expect(EMAIL_FORMAT_MESSAGE).toMatch(/อีเมล/);
  });
});
