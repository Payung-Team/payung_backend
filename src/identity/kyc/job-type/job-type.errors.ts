/**
 * JOB_TYPE_NOT_ALLOWED — บันทึกประเภทงานที่ไม่ผ่านกฎวิชาชีพ/ใบประกอบฯ (PYG-590 · S04-AC5)
 *
 * GraphQLError + extensions (แพตเทิร์นเดียวกับ LicenseError) · business rule = 422 ไม่ใช่ 400
 * `extensions.blocked` = ทุกรายการที่ไม่ผ่าน [{ jobType, blockedReason }]
 * message อ่านรู้เรื่องเอง สำหรับ client เก่าที่ไม่รู้จัก code นี้
 */
import { GraphQLError } from 'graphql';
import { JobTypeEvaluation } from './job-type-rules';

export const JOB_TYPE_ERROR = { NOT_ALLOWED: 'JOB_TYPE_NOT_ALLOWED' } as const;

export class JobTypeNotAllowedError extends GraphQLError {
  constructor(blocked: JobTypeEvaluation[]) {
    super(
      `ไม่สามารถบันทึกประเภทงานได้: ${blocked.map((b) => b.jobType).join(', ')} ` +
        '(ไม่ตรงกับวิชาชีพ หรือใบประกอบวิชาชีพยังไม่ได้รับอนุมัติ/หมดอายุ)',
      {
        extensions: {
          code: JOB_TYPE_ERROR.NOT_ALLOWED,
          statusCode: 422,
          http: { status: 422 },
          blocked: blocked.map((b) => ({ jobType: b.jobType, blockedReason: b.blockedReason })),
        },
      },
    );
  }
}
