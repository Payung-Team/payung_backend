import { Field, Float, Int, ObjectType } from '@nestjs/graphql';

/**
 * PYG-460 — ข้อมูลสุขภาพผู้รับบริการ ณ วันจอง สำหรับฝั่งผู้ดูแล (GraphQL)
 *
 * อ่านมาจาก bookings.member_details (JSONB) ซึ่งเก็บ snapshot ตอนสร้าง booking
 *
 * ── ทำไมประกาศเป็น ObjectType ไม่ใช่ scalar JSON ─────────────────────────────
 *   repo นี้ยังไม่มี graphql-type-json (คอมเมนต์เดิมใน booking.service.ts อ้างถึง
 *   ข้อนี้เป็นเหตุผลที่ยังไม่เขียนคอลัมน์นี้) แต่การเพิ่ม dependency ไม่ใช่ทางออกที่ดีกว่า
 *   อยู่ดี — scalar JSON แปลว่า schema ไม่บอกอะไรเลยว่าข้างในมีฟิลด์อะไร
 *   ฝั่ง client จะเดาเอง แล้วพอ FE พิมพ์ชื่อฟิลด์ผิดจะไม่มีใครจับได้
 *   ประกาศเป็น type จริงแล้ว codegen ฝั่ง FE ได้ typing ฟรี
 *
 * ★ ทุกฟิลด์ nullable เพราะ snapshot ของ booking เก่า (ก่อน PYG-460) ไม่มีข้อมูลเลย
 *   และฟอร์มก็ไม่ได้บังคับกรอกทุกช่อง — หน้าจอต้องรับมือกับช่องว่างได้เสมอ
 */
@ObjectType()
export class PatientProfileType {
  @Field(() => Int,      { nullable: true }) age?: number;
  @Field({ nullable: true })                 gender?: string;
  @Field(() => Float,    { nullable: true }) weight?: number;
  @Field(() => Float,    { nullable: true }) height?: number;
  @Field({ nullable: true })                 supportLevel?: string;
  @Field({ nullable: true })                 bloodGroup?: string;
  @Field(() => [String], { nullable: true }) conditions?: string[];
  @Field({ nullable: true })                 medicines?: string;
  @Field({ nullable: true })                 allergies?: string;
  @Field({ nullable: true })                 careInstructions?: string;
  @Field({ nullable: true })                 regularHospital?: string;
}
