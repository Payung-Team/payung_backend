/**
 * computeFieldChanges — เปรียบเทียบ old/new object แล้ว return เฉพาะ fields ที่เปลี่ยน
 *
 * ใช้สำหรับสร้าง caregiver_edit_logs.field_changes
 * เก็บ oldValue/newValue เป็น JSON-stringified string เพื่อรองรับทุก type (string, number, array, date)
 *
 * @param oldObj - ข้อมูลเดิม (จาก DB)
 * @param newObj - ข้อมูลใหม่ (จาก input)
 * @param fields - รายชื่อ fields ที่ต้องการเปรียบเทียบ
 * @returns Array<{ field, oldValue, newValue }> — เฉพาะ fields ที่มีค่าเปลี่ยน
 */
export function computeFieldChanges(
  oldObj: Record<string, unknown>,
  newObj: Record<string, unknown>,
  fields: string[],
): Array<{ field: string; oldValue: string | null; newValue: string | null }> {
  const changes: Array<{ field: string; oldValue: string | null; newValue: string | null }> = [];

  for (const field of fields) {
    const oldVal = oldObj[field];
    const newVal = newObj[field];

    // ข้าม field ที่ไม่ได้ส่งมา (undefined) — ไม่ถือว่าเปลี่ยน
    if (newVal === undefined) continue;

    // เปรียบเทียบแบบ JSON string เพื่อรองรับ array/object
    const oldStr = oldVal != null ? JSON.stringify(oldVal) : null;
    const newStr = newVal != null ? JSON.stringify(newVal) : null;

    if (oldStr !== newStr) {
      changes.push({ field, oldValue: oldStr, newValue: newStr });
    }
  }

  return changes;
}
