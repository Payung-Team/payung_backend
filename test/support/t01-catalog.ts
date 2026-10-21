/**
 * T-01 (ร่าง 8 ต.ค. 2026 · Phase ทดลอง) + การเปลี่ยนแปลงของ PYG-651 — "ค่าที่ควรเป็น" ของรายการกิจกรรมกลาง
 * ใช้เป็น expected ของ PYG-636 (AC2) และระดับบริการของ PYG-640 (S16 ใช้ care_level ของกิจกรรมเมื่อไม่มี override)
 * อ่านจาก CSV ต้นทาง + ตารางการเปลี่ยนแปลงที่เขียนแยกจาก SQL — ไม่อ่านจากตารางใน DB
 */
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');

export const LEVEL_TH: Record<string, string> = {
  ต้น: 'basic',
  กลาง: 'intermediate',
  สูง: 'advanced',
};
export const LEVEL_API: Record<string, string> = {
  basic: 'BASIC',
  intermediate: 'INTERMEDIATE',
  advanced: 'ADVANCED',
};

export type Row = {
  code: string;
  name: string;
  category: string;
  level: string;
};

/** T-01 ร่าง 8 ต.ค. 2026 (43 แถว) — อ่านจาก CSV ต้นทาง */
export function readT01(): Row[] {
  const lines = readFileSync(
    join(ROOT, 'docs/pyg568-t01-phase-pilot-20261008.csv'),
    'utf8',
  )
    .trim()
    .split('\n')
    .slice(1);
  return lines.map((line) => {
    const [code, name, category, level] = line.split(',');
    return { code, name, category, level: LEVEL_TH[level] };
  });
}

/**
 * PYG-651 — ปรับตาม Caregiver Service Taxonomy (Sammy อนุมัติ 8 ต.ค. 2026)
 * เขียนจากคอมเมนต์/ตารางของการ์ด ไม่ได้คัดจาก SQL ทีละบรรทัด เพื่อให้เทียบกับ migration ได้จริง
 */
const TAXONOMY_LEVEL: Record<string, string> = {
  A01: 'intermediate',
  A02: 'basic',
  A03: 'intermediate',
  D02: 'basic',
  E01: 'intermediate',
  E03: 'advanced',
  E06: 'intermediate',
  F04: 'intermediate',
};
const TAXONOMY_RENAME: Record<string, string> = {
  E01: 'วัดสัญญาณชีพครบชุด (ความดัน ชีพจร อุณหภูมิ การหายใจ) และบันทึก',
  E06: 'ทำแผลทั่วไป (แผลเล็ก แผลตื้น ไม่ติดเชื้อ)',
  G02: 'ดูแลผู้มีภาวะสมองเสื่อม ป้องกันการพลัดหลง',
};
const TAXONOMY_ADDED: Row[] = [
  {
    code: 'A10',
    name: 'โกนหนวด',
    category: 'สุขอนามัยส่วนบุคคล',
    level: 'basic',
  },
  {
    code: 'C05',
    name: 'ดูแลโภชนาการ วางแผนมื้ออาหารตามโรค',
    category: 'อาหารและโภชนาการ',
    level: 'intermediate',
  },
  {
    code: 'E08',
    name: 'ปฐมพยาบาลเบื้องต้นและ CPR / AED',
    category: 'การเฝ้าระวังสุขภาพ',
    level: 'intermediate',
  },
  {
    code: 'E09',
    name: 'ป้องกันการติดเชื้อ (ล้างมือ จัดการของปนเปื้อน)',
    category: 'การเฝ้าระวังสุขภาพ',
    level: 'intermediate',
  },
  {
    code: 'E10',
    name: 'ทำแผลถลอก ล้างแผลด้วยน้ำเกลือ ประคบร้อนเย็น',
    category: 'การพยาบาลเฉพาะ',
    level: 'basic',
  },
  // ชื่อย่อตามมติ 8 ต.ค. (migration 20261008090000)
  {
    code: 'E11',
    name: 'ทำแผลกดทับรุนแรง',
    category: 'การพยาบาลเฉพาะ',
    level: 'advanced',
  },
  {
    code: 'G04',
    name: 'รับมือพฤติกรรมผู้ป่วยสมองเสื่อม',
    category: 'ความปลอดภัยและการเฝ้าดู',
    level: 'advanced',
  },
  {
    code: 'H04',
    name: 'สอนใช้มือถือ วิดีโอคอลกับครอบครัว',
    category: 'เพื่อนและสังคม',
    level: 'basic',
  },
  {
    code: 'H05',
    name: 'ดูแลอารมณ์ (เหงา ซึม)',
    category: 'เพื่อนและสังคม',
    level: 'intermediate',
  },
  {
    code: 'H06',
    name: 'จัดการเอกสารและสิทธิการรักษา',
    category: 'เพื่อนและสังคม',
    level: 'intermediate',
  },
  {
    code: 'J01',
    name: 'ประเมินความเสี่ยงตาม checklist',
    category: 'ประเมินและประสานงาน',
    level: 'intermediate',
  },
  {
    code: 'J02',
    name: 'สอนญาติทำกิจวัตรพื้นฐาน',
    category: 'ประเมินและประสานงาน',
    level: 'intermediate',
  },
  {
    code: 'J03',
    name: 'ประเมินอาการและทำ care plan',
    category: 'ประเมินและประสานงาน',
    level: 'advanced',
  },
  {
    code: 'J04',
    name: 'สอนญาติงานทางคลินิก',
    category: 'ประเมินและประสานงาน',
    level: 'advanced',
  },
  {
    code: 'J05',
    name: 'ประสานแพทย์หรือนักกายภาพ',
    category: 'ประเมินและประสานงาน',
    level: 'advanced',
  },
];

export function expectedCatalog(): Row[] {
  const rows = readT01().map((r) => ({
    ...r,
    level: TAXONOMY_LEVEL[r.code] ?? r.level,
    name: TAXONOMY_RENAME[r.code] ?? r.name,
  }));
  return [...rows, ...TAXONOMY_ADDED].sort((a, b) =>
    a.code.localeCompare(b.code),
  );
}

/** md5 ของ code|name|category|level เรียงตาม code — ใช้เทียบกับ production แบบอ่านอย่างเดียวในรายงาน */
export const catalogMd5 = (rows: Row[]) =>
  createHash('md5')
    .update(
      rows
        .map((r) => `${r.code}|${r.name}|${r.category}|${r.level}`)
        .join('\n'),
    )
    .digest('hex');
