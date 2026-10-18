/**
 * กติกากลางของข้อมูลโรคติดเชื้อ (PYG-619) + ตารางสิทธิ์ตาม role / สถานะคำขอ
 * และยืนยันว่า type ที่มีข้อมูลนี้อยู่ที่เดียว (E8)
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { GraphQLSchemaBuilderModule, GraphQLSchemaFactory } from '@nestjs/graphql';
import { GraphQLObjectType, GraphQLInputObjectType } from 'graphql';

/** ชื่อ type หลังถอด [] และ ! */
const namedTypeOf = (t: unknown): string => String(t).replace(/[[\]!]/g, '');
import {
  INFECTION_ACK_REQUIRED_BY_STATE,
  INFECTION_DISCLOSURE_VISIBLE_STATUSES,
  buildInfectionDisclosure,
  needsInfectionAck,
} from './infection-disclosure';
import { CaregiverBookingResolver } from './caregiver-booking.resolver';
import { BookingResolver } from './booking.resolver';
import { AdminResolver } from '../admin/admin.resolver';
import { KycResolver } from '../identity/kyc/kyc.resolver';
import { CaregiverResolver } from '../identity/kyc/caregiver.resolver';

const T0 = new Date('2026-06-10T00:00:00Z');
const base = {
  status: 'pending',
  bookingCaregiverId: 'cg-1',
  viewerCaregiverId: 'cg-1',
  hasInfectiousDisease: true as boolean | null,
  infectiousDiseaseUpdatedAt: T0,
  infectionAckAt: null as Date | null,
  infectionAckBy: null as string | null,
};

describe('needsInfectionAck', () => {
  it('"มี" ต้องรับทราบเสมอ (ทุกข้อเสนอของ story ตรงกัน)', () => {
    expect(needsInfectionAck(true)).toBe(true);
    expect(INFECTION_ACK_REQUIRED_BY_STATE.yes).toBe(true);
  });

  it('"ไม่มี" และ "ยังไม่ได้ระบุ" อ่านจากตารางนโยบายเดียว (รอเคาะ — ห้ามกระจายเงื่อนไขไปที่อื่น)', () => {
    expect(needsInfectionAck(false)).toBe(INFECTION_ACK_REQUIRED_BY_STATE.no);
    expect(needsInfectionAck(null)).toBe(INFECTION_ACK_REQUIRED_BY_STATE.unset);
    expect(needsInfectionAck(undefined)).toBe(INFECTION_ACK_REQUIRED_BY_STATE.unset);
  });
});

describe('buildInfectionDisclosure — ตารางสิทธิ์ผู้ดูแล x สถานะคำขอ', () => {
  it.each([
    ['pending', true],
    ['accepted', true],
    ['confirmed', true],
    ['rejected', false],
    ['expired', false],
    ['cancelled', false],
    ['unmatched', false],
    ['completed', false],
  ])('ผู้ดูแลผู้รับคำขอ + สถานะ %s -> เห็น = %s', (status, visible) => {
    expect(buildInfectionDisclosure({ ...base, status }) !== null).toBe(visible);
  });

  it('รายการสถานะที่เห็นได้ตรงกับตาราง (จุดเดียวที่แก้เมื่อเคาะ E5/E6)', () => {
    expect([...INFECTION_DISCLOSURE_VISIBLE_STATUSES].sort()).toEqual(['accepted', 'confirmed', 'pending']);
  });

  it('E7: ผู้ดูแลที่ไม่ใช่ผู้รับคำขอ -> null ทุกสถานะ', () => {
    for (const status of ['pending', 'accepted', 'confirmed']) {
      expect(buildInfectionDisclosure({ ...base, status, viewerCaregiverId: 'cg-2' })).toBeNull();
    }
  });

  it('booking ที่ยังไม่มีผู้ดูแล -> null', () => {
    expect(buildInfectionDisclosure({ ...base, bookingCaregiverId: null })).toBeNull();
  });

  it('E1: ยังไม่ได้ระบุ -> hasInfectiousDisease = null ไม่ใช่ false', () => {
    expect(buildInfectionDisclosure({ ...base, hasInfectiousDisease: null })?.hasInfectiousDisease).toBeNull();
    expect(buildInfectionDisclosure({ ...base, hasInfectiousDisease: undefined })?.hasInfectiousDisease).toBeNull();
    expect(buildInfectionDisclosure({ ...base, hasInfectiousDisease: false })?.hasInfectiousDisease).toBe(false);
  });

  describe('acknowledgedAt (E2)', () => {
    const ackAt = (iso: string) => new Date(iso);
    it('รับทราบหลังค่าล่าสุด -> นับ', () => {
      const t = ackAt('2026-06-20T00:00:00Z');
      expect(
        buildInfectionDisclosure({ ...base, infectionAckAt: t, infectionAckBy: 'cg-1' })?.acknowledgedAt,
      ).toEqual(t);
    });
    it('รับทราบเวลาเดียวกับค่าล่าสุดพอดี -> นับ', () => {
      expect(
        buildInfectionDisclosure({ ...base, infectionAckAt: T0, infectionAckBy: 'cg-1' })?.acknowledgedAt,
      ).toEqual(T0);
    });
    it('รับทราบก่อนญาติแก้ค่า -> ไม่นับ', () => {
      expect(
        buildInfectionDisclosure({ ...base, infectionAckAt: ackAt('2026-06-01T00:00:00Z'), infectionAckBy: 'cg-1' })
          ?.acknowledgedAt,
      ).toBeNull();
    });
    it('ผู้รับทราบเป็นคนอื่น -> ไม่นับ', () => {
      expect(
        buildInfectionDisclosure({ ...base, infectionAckAt: ackAt('2026-06-20T00:00:00Z'), infectionAckBy: 'cg-2' })
          ?.acknowledgedAt,
      ).toBeNull();
    });
    it('ค่าไม่เคยถูกระบุ (ไม่มี updated_at) และมีการรับทราบ -> นับ', () => {
      const t = ackAt('2026-06-20T00:00:00Z');
      expect(
        buildInfectionDisclosure({ ...base, infectiousDiseaseUpdatedAt: null, infectionAckAt: t, infectionAckBy: 'cg-1' })
          ?.acknowledgedAt,
      ).toEqual(t);
    });
  });
});

describe('E8: type ที่พาข้อมูลโรคติดเชื้อออกไปมีที่เดียว', () => {
  it('InfectionDisclosure ถูกอ้างจาก CaregiverBookingSummary.infectionDisclosure เท่านั้น (ไม่อยู่ใน type ของ patient / admin / public / kyc)', async () => {
    const app = await NestFactory.create(GraphQLSchemaBuilderModule, { logger: false });
    await app.init();
    const schema = await app
      .get(GraphQLSchemaFactory)
      .create([CaregiverBookingResolver, BookingResolver, AdminResolver, KycResolver, CaregiverResolver]);

    const holders: string[] = [];
    const sensitiveNamed: string[] = [];
    for (const type of Object.values(schema.getTypeMap())) {
      if (type.name.startsWith('__')) continue;
      if (!(type instanceof GraphQLObjectType) && !(type instanceof GraphQLInputObjectType)) continue;
      for (const field of Object.values(type.getFields())) {
        if (namedTypeOf(field.type) === 'InfectionDisclosure') holders.push(`${type.name}.${field.name}`);
        if (/infect/i.test(field.name) && type.name !== 'InfectionDisclosure') {
          sensitiveNamed.push(`${type.name}.${field.name}`);
        }
      }
    }
    expect(holders).toEqual(['CaregiverBookingSummary.infectionDisclosure']);
    // field ที่ชื่อเกี่ยวกับโรคติดเชื้อมีที่เดียวเช่นกัน — ไม่มี type ผู้ดูแลสาธารณะ/แอดมิน/KYC ถือค่านี้
    expect(sensitiveNamed).toEqual(['CaregiverBookingSummary.infectionDisclosure']);
    // argument ของ acceptBooking เป็น optional (client เก่าต้องไม่พังที่ชั้น validation)
    const accept = schema.getMutationType()!.getFields()['acceptBooking'];
    const arg = accept.args.find((a) => a.name === 'infectionAcknowledged');
    expect(arg).toBeDefined();
    expect(String(arg!.type)).toBe('Boolean');
  });
});
