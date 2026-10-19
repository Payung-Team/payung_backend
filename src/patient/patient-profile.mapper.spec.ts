import {
  ageToDateOfBirth,
  dateOfBirthToAge,
  toCareRecipientColumns,
  toPatientProfile,
  PatientProfileRow,
} from './patient-profile.mapper';

/** แถวเปล่าตามรูปทรงที่ select จริงคืนมา */
function row(overrides: Partial<PatientProfileRow> = {}): PatientProfileRow {
  return {
    date_of_birth:       null,
    gender:              null,
    weight_kg:           null,
    height_cm:           null,
    mobility_level:      null,
    medical_conditions:  [],
    current_medications: null,
    allergies:           null,
    blood_type:          null,
    care_notes:          null,
    preferred_hospital:  null,
    ...overrides,
  };
}

describe('patient-profile.mapper (PYG-460)', () => {
  describe('อายุ ↔ วันเกิด', () => {
    it('อ่านกลับได้เลขเดิมที่ผู้ใช้กรอก', () => {
      // ฟอร์มถามแค่อายุ ไม่ได้ถามวันเกิด — สิ่งเดียวที่ต้องรับประกันคือ
      // กรอก 72 แล้วเปิดฟอร์มขึ้นมาใหม่ต้องเห็น 72 ไม่ใช่ 71 หรือ 73
      for (const age of [0, 1, 45, 72, 99, 130]) {
        expect(dateOfBirthToAge(ageToDateOfBirth(age))).toBe(age);
      }
    });

    it('คืน undefined เมื่อไม่มีวันเกิด', () => {
      expect(dateOfBirthToAge(null)).toBeUndefined();
      expect(dateOfBirthToAge(undefined)).toBeUndefined();
    });
  });

  describe('เพศ / ระดับการช่วยเหลือ', () => {
    it('แปลงข้อความไทยจากปุ่ม → enum ของ DB', () => {
      const cols = toCareRecipientColumns({
        gender:       'ชาย',
        supportLevel: 'ช่วยเหลือตัวเองได้ดี',
      });
      expect(cols.gender).toBe('male');
      expect(cols.mobility_level).toBe('independent');
    });

    it('แปลงกลับ enum → ข้อความเดิม ไม่ใช่ข้อความที่ใกล้เคียง', () => {
      const p = toPatientProfile(row({ gender: 'female', mobility_level: 'bedridden' }));
      expect(p!.gender).toBe('หญิง');
      expect(p!.supportLevel).toBe('ช่วยเหลือตัวเองไม่ได้ / ติดเตียง');
    });

    it("คืน 'ใช้รถเข็น' ตามจริง แม้ฟอร์มจะยังไม่มีปุ่มนี้", () => {
      // FE มี 3 ตัวเลือก DB มี 4 — ถ้าเจอ wheelchair ห้ามยัดให้เป็น assisted
      // เพราะการโกหกระดับการช่วยเหลือของคนไข้อันตรายกว่าปุ่มที่ไม่ถูกไฮไลต์
      const p = toPatientProfile(row({ mobility_level: 'wheelchair' }));
      expect(p!.supportLevel).toBe('ใช้รถเข็น');
    });
  });

  describe('toCareRecipientColumns', () => {
    it('คืนเฉพาะคีย์ที่ส่งมาจริง (ใช้กับ update ได้โดยไม่ล้างค่าเดิม)', () => {
      const cols = toCareRecipientColumns({ age: 72 });
      expect(Object.keys(cols)).toEqual(['date_of_birth']);
    });

    it('ส่งค่าว่างมาจริง = ตั้งใจล้างช่องนั้น ต้องเขียนลง DB', () => {
      // ต่างจาก undefined: ผู้ใช้ลบข้อความในช่อง "ประวัติแพ้ยา" ทิ้งแล้วกดบันทึก
      // ต้องล้างของเดิมจริง ไม่ใช่เก็บค่าเก่าไว้เงียบ ๆ
      const cols = toCareRecipientColumns({ allergies: '' });
      expect(cols).toHaveProperty('allergies', '');
    });
  });

  describe('toPatientProfile', () => {
    it('คืน undefined เมื่อทุกช่องว่าง', () => {
      expect(toPatientProfile(row())).toBeUndefined();
    });

    it('ไม่คืน conditions เป็น array ว่าง', () => {
      const p = toPatientProfile(row({ medical_conditions: [], allergies: 'แพ้ฝุ่น' }));
      expect(p!.conditions).toBeUndefined();
    });

    it('แปลง Decimal ของ Prisma เป็น number ไม่ใช่ string', () => {
      // ปล่อยเป็น Decimal แล้ว JSON.stringify จะได้ "54" ซึ่ง FE เอาไปคำนวณต่อไม่ได้
      const decimal = { toNumber: () => 54.5 };
      const p = toPatientProfile(row({ weight_kg: decimal }));
      expect(p!.weight).toBe(54.5);
      expect(typeof p!.weight).toBe('number');
    });
  });
});
