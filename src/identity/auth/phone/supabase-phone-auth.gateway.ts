/**
 * SupabasePhoneAuthGateway — PhoneAuthGateway ตัวจริงที่คุยกับ Supabase Auth (PYG-603)
 *
 * มติ 7 ต.ค. 2026 (Sammy): ยืนยันเบอร์ผ่าน Supabase Auth — Supabase สร้างรหัส ส่ง SMS
 * (ผ่านผู้ให้บริการที่ตั้งใน Dashboard) เก็บรหัสเป็น hash และตรวจรหัสให้ · BE ไม่เก็บรหัสเลย (R10)
 *
 * ── ทำไมสร้าง Supabase client ใหม่ทุกครั้ง ไม่ใช้ SupabaseService.getClient() ─────
 *   client ของ supabase-js "จำ session" ไว้ในตัว — verifyOtp / refreshSession สำเร็จเมื่อไหร่
 *   client จะเก็บ session ของผู้ใช้คนนั้นไว้ ถ้าใช้ client ตัวกลางที่ทั้งแอปใช้ร่วมกัน session ของ
 *   ผู้ใช้คนหนึ่งจะค้างอยู่ใน client ที่คำขอของคนอื่นใช้ต่อ → สร้างใหม่ต่อคำขอ + ปิดการจำ session
 *   (แนวเดียวกับ AuthService.logout / updatePassword ที่สร้าง tempClient ต่อคำขอ)
 *
 * ── ทำไมผูกเบอร์ใช้ fetch ตรง ไม่ใช้ client.auth.updateUser ────────────────────
 *   updateUser ของ supabase-js ต้องมี session ที่ "เก็บไว้ใน client" (มี refresh token ด้วย)
 *   แต่ BE ได้จาก FE แค่ access token ใน header → เรียก REST ของ Supabase ตรง ๆ
 *   (PUT /auth/v1/user ด้วย Bearer access token ของผู้ใช้) ซึ่งเป็น endpoint เดียวกับที่ updateUser เรียก
 *
 * ── การอ่าน auth.users ──────────────────────────────────────────────────────
 *   Prisma ไม่ได้เปิด multiSchema → ใช้ raw SQL (role ของ DATABASE_URL อ่าน auth schema ได้
 *   ตามผลตรวจใน PYG-602) · อ่านอย่างเดียว ไม่เขียน auth.users ตรง ๆ เด็ดขาด (ให้ Supabase เขียนเอง)
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import { PrismaService } from '../../../common/prisma.service';
import {
  type LoginPhoneStatus,
  type PhoneAccount,
  PhoneAuthGateway,
  PhoneGatewayError,
  type PhoneGatewayFailure,
  type PhoneSession,
} from './phone-auth.gateway';

/** รอ Supabase นานสุดกี่มิลลิวินาที — เกินนี้ถือว่า "ส่งไม่สำเร็จ" (E11 รวม "หมดเวลา") */
const SUPABASE_TIMEOUT_MS = 10_000;

/** รูปแบบ UUID — กัน raw SQL ที่ cast เป็น uuid ล้มเพราะค่าแปลก ๆ */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * แปลง error ของ Supabase เป็นประเภทความล้มเหลวที่ service ใช้ตัดสิน — pure function เทสได้ตรง ๆ
 *
 * ★ อ่านจาก `code` (error_code ของ Supabase) เป็นหลัก ไม่อ่านข้อความ — ข้อความเปลี่ยนได้ทุกเวอร์ชัน
 *   ใช้ข้อความแค่ตอนดึง "อีกกี่วินาที" ของ rate limit (Supabase ไม่ได้ส่งเป็นตัวเลขแยก)
 */
export function toGatewayError(err: unknown): PhoneGatewayError {
  if (err instanceof PhoneGatewayError) return err;

  const e = (err ?? {}) as {
    code?: unknown;
    status?: unknown;
    message?: unknown;
  };
  const code = typeof e.code === 'string' ? e.code : undefined;
  const status = typeof e.status === 'number' ? e.status : undefined;
  const message = typeof e.message === 'string' ? e.message : String(err);

  const kind = ((): PhoneGatewayFailure => {
    switch (code) {
      // Supabase ตอบตัวนี้ทั้งรหัสผิดและรหัสหมดอายุ ("Token has expired or is invalid")
      case 'otp_expired':
        return 'otp_rejected';
      case 'over_sms_send_rate_limit':
      case 'over_request_rate_limit':
        return 'rate_limited';
      case 'sms_send_failed':
      case 'phone_provider_disabled': // ยังไม่ได้เปิด phone provider ใน Dashboard
      case 'hook_timeout':
      case 'hook_timeout_after_retry':
        return 'sms_failed';
      case 'phone_exists':
      case 'user_already_exists':
        return 'phone_taken';
      case 'otp_disabled': // "Signups not allowed for otp" — shouldCreateUser: false แต่ไม่มีผู้ใช้
      case 'user_not_found':
        return 'no_account';
      case 'refresh_token_not_found':
      case 'refresh_token_already_used':
      case 'session_not_found':
      case 'session_expired':
      case 'bad_jwt':
      case 'no_authorization':
        return 'session_invalid';
      case 'validation_failed':
        return 'phone_invalid';
      default:
        break;
    }
    // ไม่มี code แต่ status บอกได้ (Supabase เวอร์ชันเก่า / error ที่ไม่ได้ติด code)
    if (status === 429) return 'rate_limited';
    // verifyOtp ของ Supabase บางเวอร์ชันตอบ 403 โดยไม่มี code เมื่อรหัสผิด/หมดอายุ
    if (status === 403 && /expired|invalid/i.test(message))
      return 'otp_rejected';
    return 'unavailable';
  })();

  return new PhoneGatewayError(
    kind,
    kind === 'rate_limited' ? parseRetryAfterSeconds(message) : undefined,
    `${code ?? '-'} ${status ?? '-'} ${message}`,
  );
}

/** "For security purposes, you can only request this after 42 seconds." → 42 */
function parseRetryAfterSeconds(message: string): number | undefined {
  const match = /(\d+)\s*seconds?/i.exec(message);
  return match ? Number(match[1]) : undefined;
}

@Injectable()
export class SupabasePhoneAuthGateway extends PhoneAuthGateway {
  private readonly logger = new Logger(SupabasePhoneAuthGateway.name);
  private readonly url: string;
  private readonly anonKey: string;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super();
    this.url = config.getOrThrow<string>('SUPABASE_URL');
    this.anonKey = config.getOrThrow<string>('SUPABASE_ANON_KEY');
  }

  // ─── อ่าน auth.users ───────────────────────────────────────────────────────

  async findAccountByPhone(
    supabasePhone: string,
  ): Promise<PhoneAccount | null> {
    // Supabase เก็บแบบไม่มี + ("66812345678") — ใส่แบบมี + ไว้ด้วยเผื่อ Supabase เปลี่ยนพฤติกรรม
    // (PYG-602: ยังยืนยันรูปแบบที่เก็บจริงบนโปรเจกต์นี้ไม่ได้ เพราะยังไม่มีแถวไหนมีเบอร์)
    const rows = await this.prisma.$queryRaw<
      Array<{
        supabase_uid: string;
        phone_confirmed: boolean;
        user_id: string | null;
      }>
    >`
      SELECT au.id::text                          AS supabase_uid,
             (au.phone_confirmed_at IS NOT NULL)  AS phone_confirmed,
             u.id                                 AS user_id
      FROM auth.users au
      LEFT JOIN public.users u ON u.supabase_uid = au.id::text
      WHERE au.phone IN (${supabasePhone}, ${`+${supabasePhone}`})
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      supabaseUid: row.supabase_uid,
      phoneConfirmed: row.phone_confirmed,
      userId: row.user_id,
    };
  }

  async loginPhoneStatus(userId: string): Promise<LoginPhoneStatus | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { supabaseUid: true },
    });
    if (!user) return null;
    // supabase_uid ไม่มี FK (PYG-602) — ค่าแปลก ๆ จะทำให้ cast ::uuid ล้มทั้ง query → ถือว่าไม่มีเบอร์
    if (!UUID_PATTERN.test(user.supabaseUid))
      return { phone: null, confirmed: false };

    // ★ id = $1::uuid (ไม่ใช่ id::text = $1) → ใช้ primary key index ของ auth.users ได้
    const rows = await this.prisma.$queryRaw<
      Array<{ phone: string | null; confirmed: boolean }>
    >`
      SELECT phone, (phone_confirmed_at IS NOT NULL) AS confirmed
      FROM auth.users
      WHERE id = ${user.supabaseUid}::uuid
    `;
    const row = rows[0];
    return row
      ? { phone: row.phone, confirmed: row.confirmed }
      : { phone: null, confirmed: false };
  }

  // ─── รหัส OTP ─────────────────────────────────────────────────────────────

  async sendSmsOtp(e164: string, createUser: boolean): Promise<void> {
    const { error } = await this.client().auth.signInWithOtp({
      phone: e164,
      options: { shouldCreateUser: createUser, channel: 'sms' },
    });
    if (error) throw toGatewayError(error);
  }

  async verifySmsOtp(e164: string, code: string): Promise<PhoneSession> {
    const { data, error } = await this.client().auth.verifyOtp({
      phone: e164,
      token: code,
      type: 'sms',
    });
    if (error) throw toGatewayError(error);
    return this.toSession(data.session, data.user?.id);
  }

  async sendPhoneChangeOtp(accessToken: string, e164: string): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${this.url}/auth/v1/user`, {
        method: 'PUT',
        headers: {
          apikey: this.anonKey,
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          // รูปแบบ error ใหม่ของ Supabase: { code: "phone_exists", message } — ตรงกับที่ supabase-js ใช้
          'X-Supabase-Api-Version': '2024-01-01',
        },
        body: JSON.stringify({ phone: e164 }),
        signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS),
      });
    } catch (err) {
      // เครือข่ายล่ม / หมดเวลา
      throw new PhoneGatewayError(
        'sms_failed',
        undefined,
        err instanceof Error ? err.message : String(err),
      );
    }
    if (res.ok) return;

    const body = (await res.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    // Supabase เวอร์ชันเก่าใส่ code ไว้ที่ error_code และ code เป็นตัวเลข HTTP
    const code =
      typeof body.error_code === 'string'
        ? body.error_code
        : typeof body.code === 'string'
          ? body.code
          : undefined;
    const message =
      typeof body.message === 'string'
        ? body.message
        : typeof body.msg === 'string'
          ? body.msg
          : `HTTP ${res.status}`;
    throw toGatewayError({ code, status: res.status, message });
  }

  async verifyPhoneChangeOtp(
    e164: string,
    code: string,
  ): Promise<{ supabaseUid: string }> {
    const { data, error } = await this.client().auth.verifyOtp({
      phone: e164,
      token: code,
      type: 'phone_change',
    });
    if (error) throw toGatewayError(error);
    if (!data.user?.id)
      throw new PhoneGatewayError(
        'unavailable',
        undefined,
        'verifyOtp returned no user',
      );
    return { supabaseUid: data.user.id };
  }

  async refreshSession(refreshToken: string): Promise<PhoneSession> {
    const { data, error } = await this.client().auth.refreshSession({
      refresh_token: refreshToken,
    });
    if (error) throw toGatewayError(error);
    return this.toSession(data.session, data.user?.id);
  }

  // ─── ภายใน ───────────────────────────────────────────────────────────────

  /** client ใหม่ต่อคำขอ ไม่จำ session ไม่ต่ออายุเอง (ดูเหตุผลที่หัวไฟล์) */
  private client() {
    return createClient(this.url, this.anonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: {
        // supabase-js ไม่มี timeout ในตัว — ผู้ให้บริการ SMS ค้างจะทำให้คำขอค้างไปด้วย
        fetch: (
          input: Parameters<typeof fetch>[0],
          init?: Parameters<typeof fetch>[1],
        ) =>
          fetch(input, {
            ...init,
            signal: init?.signal
              ? AbortSignal.any([
                  init.signal,
                  AbortSignal.timeout(SUPABASE_TIMEOUT_MS),
                ])
              : AbortSignal.timeout(SUPABASE_TIMEOUT_MS),
          }),
      },
    });
  }

  private toSession(
    session: {
      access_token: string;
      refresh_token: string;
      user?: { id: string };
    } | null,
    userId: string | undefined,
  ): PhoneSession {
    const supabaseUid = userId ?? session?.user?.id;
    if (!session || !supabaseUid) {
      this.logger.error({ event: 'phone_auth.gateway.no_session' });
      throw new PhoneGatewayError(
        'unavailable',
        undefined,
        'no session returned',
      );
    }
    return {
      supabaseUid,
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
    };
  }
}
