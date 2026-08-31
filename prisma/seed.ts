/**
 * Admin Seed Script (PYG-132)
 *
 * วัตถุประสงค์:
 * - สร้าง initial admin account ตอน setup ระบบครั้งแรก
 * - ใช้ ENV: ADMIN_EMAIL, ADMIN_PASSWORD
 * - Idempotent (รันซ้ำได้ ไม่ error ไม่ create ซ้ำ)
 *
 * Flow:
 *   1. อ่าน ADMIN_EMAIL, ADMIN_PASSWORD จาก .env
 *   2. ตรวจว่ามี admin user ใน DB ของเราอยู่แล้วไหม → ถ้ามี skip
 *   3. ตรวจว่ามี auth user ใน Supabase อยู่แล้วไหม → ถ้ามี ใช้ uid เดิม, ถ้าไม่ create
 *   4. INSERT row ในตาราง users (role = 3 = admin)
 *
 * วิธีรัน:
 *   npx prisma db seed
 *
 * หรือถ้าใช้ Prisma migrate ตอน reset DB:
 *   npx prisma migrate reset --force
 *   ↑ Prisma จะรัน seed อัตโนมัติหลัง migrate
 *
 * ⚠️ ต้องการ ENV variables:
 *   - DATABASE_URL              (มีอยู่แล้ว)
 *   - SUPABASE_URL              (มีอยู่แล้ว)
 *   - SUPABASE_SERVICE_ROLE_KEY (มีอยู่แล้ว — admin client ต้องใช้ key นี้)
 *   - ADMIN_EMAIL               (PYG-132 — ใหม่)
 *   - ADMIN_PASSWORD            (PYG-132 — ใหม่)
 */
// load .env ก่อนทุกอย่าง — เผื่อกรณีที่รัน seed.ts ตรงๆ ด้วย ts-node
// (ถ้ารันผ่าน `prisma db seed`, prisma.config.ts โหลด dotenv ให้แล้ว — แต่เก็บไว้ก็ปลอดภัย)
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { createClient } from '@supabase/supabase-js';

/** Role number ของ admin — ต้องตรงกับ AdminGuard.ADMIN_ROLE */
const ADMIN_ROLE = 3;

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 [seed] Starting admin seed...');

  // ── 1. อ่าน ENV ──────────────────────────────────────────────────────
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Validate ENV ก่อน — ดีกว่ารัน script ไปครึ่งทางแล้ว fail
  if (!adminEmail || !adminPassword) {
    throw new Error(
      '[seed] Missing ADMIN_EMAIL or ADMIN_PASSWORD in .env — see .env.example',
    );
  }
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      '[seed] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env',
    );
  }

  // ── 2. เช็คว่ามี admin user ใน DB ของเราอยู่แล้วไหม (idempotent) ─────
  // ถ้ามีอยู่แล้ว → skip ไปเลย (ไม่ create ซ้ำ, ไม่ error)
  const existingUser = await prisma.user.findUnique({
    where: { email: adminEmail },
  });

  if (existingUser) {
    if (existingUser.role === ADMIN_ROLE) {
      console.log(
        `✅ [seed] Admin user already exists (email=${adminEmail}, id=${existingUser.id}). Skipping.`,
      );
      return;
    }
    // มี user email นี้แล้ว แต่ไม่ใช่ admin → เป็น user ปกติที่ใช้ email เดียวกับที่จะ seed
    throw new Error(
      `[seed] User ${adminEmail} exists but role=${existingUser.role} (not admin). ` +
        `เปลี่ยน ADMIN_EMAIL หรือลบ user เดิมก่อน`,
    );
  }

  // ── 3. สร้าง / หา Supabase Auth user ───────────────────────────────────
  // ใช้ service role key เพราะ:
  //   - admin.createUser ต้องการ service role (anon key ใช้ไม่ได้)
  //   - email_confirm: true → ไม่ต้องให้ admin คลิก confirm email
  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false, // script รันสั้นๆ ไม่ต้อง refresh token
      persistSession: false, // ไม่ต้อง save session ลง storage
    },
  });

  // ลอง create ก่อน — ถ้า email มีใน Supabase Auth อยู่แล้ว createUser จะ error
  // เราเลยต้อง handle case "user exists" และดึง uid เดิมมาใช้
  let supabaseUid: string;

  console.log(`🔐 [seed] Creating Supabase auth user for ${adminEmail}...`);
  const { data: createData, error: createError } =
    await supabaseAdmin.auth.admin.createUser({
      email: adminEmail,
      password: adminPassword,
      email_confirm: true, // mark email confirmed (ไม่ต้อง verify email)
      user_metadata: { role: 'admin', seeded: true },
    });

  if (createError) {
    // ถ้า email ซ้ำใน Supabase Auth (เกิดได้ถ้าเคยรัน seed แต่ DB ถูกเคลียร์)
    // → ดึง uid ของ user เดิมมาใช้แทน
    const isDuplicate =
      createError.message?.toLowerCase().includes('already') ||
      createError.message?.toLowerCase().includes('exists') ||
      createError.message?.toLowerCase().includes('registered');

    if (!isDuplicate) {
      throw new Error(
        `[seed] Failed to create Supabase auth user: ${createError.message}`,
      );
    }

    console.log(
      `ℹ️  [seed] Supabase auth user already exists. Looking up existing uid...`,
    );

    // listUsers พร้อม filter email — ดึง user เดิมเพื่อใช้ uid
    const { data: listData, error: listError } =
      await supabaseAdmin.auth.admin.listUsers();

    if (listError) {
      throw new Error(
        `[seed] Failed to list users: ${listError.message}`,
      );
    }

    const existing = listData.users.find((u) => u.email === adminEmail);
    if (!existing) {
      throw new Error(
        `[seed] Supabase says user exists but listUsers can't find email ${adminEmail}`,
      );
    }

    supabaseUid = existing.id;
    console.log(`✅ [seed] Reusing existing Supabase uid: ${supabaseUid}`);
  } else {
    if (!createData.user) {
      throw new Error('[seed] Supabase returned success but no user object');
    }
    supabaseUid = createData.user.id;
    console.log(`✅ [seed] Created new Supabase auth user: ${supabaseUid}`);
  }

  // ── 4. สร้าง row ใน users table ของเรา ─────────────────────────────────
  // role = 3 (admin), displayName = "Admin"
  console.log(`💾 [seed] Inserting admin row in users table...`);
  const adminUser = await prisma.user.create({
    data: {
      supabaseUid,
      email: adminEmail,
      displayName: 'Admin',
      role: ADMIN_ROLE,
      isActive: true,
    },
  });

  console.log(
    `🎉 [seed] Admin seeded successfully!\n` +
      `   id          = ${adminUser.id}\n` +
      `   email       = ${adminUser.email}\n` +
      `   role        = ${adminUser.role} (admin)\n` +
      `   supabaseUid = ${adminUser.supabaseUid}\n`,
  );
}

main()
  .catch((err) => {
    console.error('❌ [seed] Failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
