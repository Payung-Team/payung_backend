/**
 * PYG-285 TC_PYG-S3_04 — Transfer Flow QA
 * Tests: markPaymentTransferred mutation + adminPayments query + paymentHistory query
 *
 * Run: node test/qa-pyg285-transfer-flow.js
 * Requires: BE server on :3000 + DB connection
 */
'use strict';

const { createClient } = require('@supabase/supabase-js');
const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');

// ── Config ────────────────────────────────────────────────────────────────────
const SUPABASE_URL          = 'https://evsewucpighcbnhofmug.supabase.co';
const SUPABASE_ANON_KEY     = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV2c2V3dWNwaWdoY2JuaG9mbXVnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5ODgzNDcsImV4cCI6MjA4OTU2NDM0N30.sYMiLMF3WXAOqWhqBoNN1MszKiUhiUCZ0Uz4x50_JDI';
const SUPABASE_SERVICE_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV2c2V3dWNwaWdoY2JuaG9mbXVnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3Mzk4ODM0NywiZXhwIjoyMDg5NTY0MzQ3fQ.biJGxh-0n9_Uq6nkSvMdR0WttbADCyMvYmQLt6tCoFo';
const GQL                   = 'http://localhost:3000/graphql';

const TS    = Date.now();
const SEED  = { adminEmail: `qa-admin-${TS}@payung-test.local`, patientEmail: `qa-patient-${TS}@payung-test.local`, password: 'QAtest!2024xX' };

// Existing caregiver entities (seed data from DB)
const EXISTING = {
  caregiverUserId: '67814fba-294d-4d4e-9106-f727f4134163',   // User.id (role=2)
  caregiverId:     'df1fd0a6-b967-421f-a4cb-14355871d726',   // Caregiver.id
};

const supabaseAdmin  = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const supabasePublic = createClient(SUPABASE_URL, SUPABASE_ANON_KEY,   { auth: { autoRefreshToken: false, persistSession: false } });
const prisma         = new PrismaClient();

// ── State (filled during setup) ───────────────────────────────────────────────
const state = {
  adminAuthId:   null,   // Supabase auth UID for test admin
  patientAuthId: null,   // Supabase auth UID for test patient
  adminDbId:     null,   // DB User.id for test admin
  patientDbId:   null,   // DB User.id for test patient
  bookingId:     null,
  paymentId:     null,
  adminToken:    null,
  patientToken:  null,
  transferRef:   `TRF-QA-${TS}`,
};

// ── Helpers ───────────────────────────────────────────────────────────────────
async function gql(query, variables, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res  = await fetch(GQL, { method: 'POST', headers, body: JSON.stringify({ query, variables }) });
  return res.json();
}

const results = [];
function record(id, scope, result, evidence) {
  results.push({ id, scope, result, evidence });
  const icon = result === 'PASS' ? '✅' : result === 'FAIL' ? '❌' : '⚠️ ';
  console.log(`  ${icon} ${id} [${scope}] ${result}: ${evidence}`);
}

// ── Setup ─────────────────────────────────────────────────────────────────────
async function setup() {
  console.log('\n=== SETUP ===');

  // 1. Create Supabase auth users
  const { data: adminAuthData, error: e1 } = await supabaseAdmin.auth.admin.createUser({
    email: SEED.adminEmail, password: SEED.password, email_confirm: true,
  });
  if (e1) throw new Error(`Create admin auth user failed: ${e1.message}`);
  state.adminAuthId = adminAuthData.user.id;
  console.log(`  Created Supabase auth admin: ${SEED.adminEmail} (${state.adminAuthId})`);

  const { data: patientAuthData, error: e2 } = await supabaseAdmin.auth.admin.createUser({
    email: SEED.patientEmail, password: SEED.password, email_confirm: true,
  });
  if (e2) throw new Error(`Create patient auth user failed: ${e2.message}`);
  state.patientAuthId = patientAuthData.user.id;
  console.log(`  Created Supabase auth patient: ${SEED.patientEmail} (${state.patientAuthId})`);

  // 2. Create matching DB users
  state.adminDbId = crypto.randomUUID();
  await prisma.user.create({
    data: { id: state.adminDbId, supabaseUid: state.adminAuthId, email: SEED.adminEmail, role: 4, isActive: true },
  });
  console.log(`  Created DB admin user: ${state.adminDbId} role=4`);

  state.patientDbId = crypto.randomUUID();
  await prisma.user.create({
    data: { id: state.patientDbId, supabaseUid: state.patientAuthId, email: SEED.patientEmail, role: 1, isActive: true },
  });
  console.log(`  Created DB patient user: ${state.patientDbId} role=1`);

  // 3. Sign in to get JWTs
  const { data: adminSession, error: e3 } = await supabasePublic.auth.signInWithPassword({ email: SEED.adminEmail, password: SEED.password });
  if (e3) throw new Error(`Admin sign in failed: ${e3.message}`);
  state.adminToken = adminSession.session.access_token;
  console.log('  Obtained admin JWT');

  const { data: patientSession, error: e4 } = await supabasePublic.auth.signInWithPassword({ email: SEED.patientEmail, password: SEED.password });
  if (e4) throw new Error(`Patient sign in failed: ${e4.message}`);
  state.patientToken = patientSession.session.access_token;
  console.log('  Obtained patient JWT');

  // 4. Create booking via raw SQL (needs DB-level enum casts)
  state.bookingId = crypto.randomUUID();
  await prisma.$executeRaw`
    INSERT INTO bookings (
      id, patient_id, caregiver_id,
      service_locations, service_type, time_slot,
      start_time, duration_hours, location_address,
      booking_date, status
    ) VALUES (
      ${state.bookingId}::uuid,
      ${state.patientDbId},
      ${EXISTING.caregiverId},
      ARRAY['home']::text[],
      'general_care'::booking_service_type,
      'morning'::time_slot,
      '09:00:00',
      4,
      'QA Test Address 123',
      CURRENT_DATE,
      'accepted'::booking_status
    )
  `;
  console.log(`  Created booking: ${state.bookingId}`);

  // 5. Create payment in pending state
  state.paymentId = crypto.randomUUID();
  await prisma.$executeRaw`
    INSERT INTO payments (
      id, booking_id, patient_id, caregiver_id,
      amount, currency, payment_method, payment_status
    ) VALUES (
      ${state.paymentId}::uuid,
      ${state.bookingId}::uuid,
      ${state.patientDbId},
      ${EXISTING.caregiverUserId},
      '1500.00',
      'THB',
      'credit_card',
      'pending'::payment_status_enum
    )
  `;
  console.log(`  Created payment: ${state.paymentId} status=pending`);

  // 6. Run FSM transitions: pending → held → captured (using Prisma directly)
  await prisma.paymentStatusHistory.create({
    data: {
      paymentId: state.paymentId,
      fromStatus: null,
      toStatus: 'pending',
      reason: 'QA seed: initial state',
    },
  });

  await prisma.$executeRaw`UPDATE payments SET payment_status = 'held'::payment_status_enum, updated_at = NOW() WHERE id = ${state.paymentId}::uuid`;
  await prisma.paymentStatusHistory.create({
    data: { paymentId: state.paymentId, fromStatus: 'pending', toStatus: 'held', reason: 'QA seed: pending → held' },
  });

  await prisma.$executeRaw`UPDATE payments SET payment_status = 'captured'::payment_status_enum, updated_at = NOW() WHERE id = ${state.paymentId}::uuid`;
  await prisma.paymentStatusHistory.create({
    data: { paymentId: state.paymentId, fromStatus: 'held', toStatus: 'captured', reason: 'QA seed: held → captured' },
  });

  console.log('  FSM transitions: pending → held → captured (3 history rows inserted)');

  // Verify payment is captured
  const [{ payment_status }] = await prisma.$queryRaw`SELECT payment_status FROM payments WHERE id = ${state.paymentId}::uuid`;
  if (String(payment_status) !== 'captured') throw new Error(`Expected captured, got ${payment_status}`);
  console.log(`  Verified: payment is now in captured state ✓`);
}

// ── Test Cases ────────────────────────────────────────────────────────────────

async function tc02_noAuth() {
  // TC_02: No auth token → UNAUTHENTICATED
  const res = await gql(`mutation { markPaymentTransferred(paymentId: "${state.paymentId}", transferRef: "SKIP") { id } }`, {}, null);
  const errMsg = res.errors?.[0]?.message ?? '';
  if (res.errors && (errMsg.includes('Missing') || errMsg.includes('token') || errMsg.includes('Unauthorized') || errMsg.includes('authorization'))) {
    record('TC_02', 'auth', 'PASS', `401/UNAUTHENTICATED — "${errMsg}"`);
  } else {
    record('TC_02', 'auth', 'FAIL', `Expected UNAUTHENTICATED, got: ${JSON.stringify(res.errors ?? res.data)}`);
  }
}

async function tc03_nonAdmin() {
  // TC_03: Patient role (role=1) → FORBIDDEN
  const res = await gql(`mutation { markPaymentTransferred(paymentId: "${state.paymentId}", transferRef: "SKIP") { id } }`, {}, state.patientToken);
  const errMsg = res.errors?.[0]?.message ?? '';
  if (res.errors && (errMsg.toLowerCase().includes('forbidden') || errMsg.toLowerCase().includes('access denied') || errMsg.toLowerCase().includes('role'))) {
    record('TC_03', 'rbac', 'PASS', `403/FORBIDDEN — "${errMsg}"`);
  } else {
    record('TC_03', 'rbac', 'FAIL', `Expected FORBIDDEN, got: ${JSON.stringify(res.errors ?? res.data)}`);
  }
}

async function tc05_adminPayments_beforeTransfer() {
  // TC_05a: adminPayments returns the captured payment before we transfer
  const res = await gql(`query { adminPayments(input: { status: captured, page: 1, limit: 100 }) { totalCount nodes { id paymentStatus } } }`, {}, state.adminToken);
  if (res.errors) {
    record('TC_05', 'adminPayments', 'FAIL', `GQL error: ${res.errors[0].message}`);
    return;
  }
  const { totalCount, nodes } = res.data.adminPayments;
  const found = nodes.some(n => n.id === state.paymentId && n.paymentStatus === 'captured');
  if (found && totalCount >= 1) {
    record('TC_05', 'adminPayments', 'PASS', `totalCount=${totalCount}, seeded payment found with status=captured`);
  } else {
    record('TC_05', 'adminPayments', 'FAIL', `seeded paymentId not found in list. nodes=${JSON.stringify(nodes)}`);
  }
}

async function tc01_happyPath() {
  // TC_01: Admin marks payment as transferred → success
  const res = await gql(
    `mutation MarkTransferred($pid: ID!, $ref: String!, $notes: String) {
       markPaymentTransferred(paymentId: $pid, transferRef: $ref, notes: $notes) {
         id paymentStatus updatedAt
       }
     }`,
    { pid: state.paymentId, ref: state.transferRef, notes: 'QA TC_01 transfer' },
    state.adminToken,
  );

  if (res.errors) {
    record('TC_01', 'happy-path', 'FAIL', `GQL error: ${res.errors[0].message}`);
    return;
  }
  const p = res.data.markPaymentTransferred;
  if (p.id === state.paymentId && p.paymentStatus === 'transferred') {
    // Verify DB
    const [row] = await prisma.$queryRaw`SELECT payment_status, metadata FROM payments WHERE id = ${state.paymentId}::uuid`;
    const meta  = typeof row.metadata === 'object' ? row.metadata : JSON.parse(row.metadata);
    const dbOk  = String(row.payment_status) === 'transferred' && meta.transferRef === state.transferRef;
    record('TC_01', 'happy-path', dbOk ? 'PASS' : 'FAIL',
      dbOk
        ? `status=transferred ✓, metadata.transferRef=${meta.transferRef} ✓`
        : `DB mismatch: status=${row.payment_status}, meta=${JSON.stringify(meta)}`
    );
  } else {
    record('TC_01', 'happy-path', 'FAIL', `Unexpected response: ${JSON.stringify(p)}`);
  }
}

async function tc04_notCaptured() {
  // TC_04: Try to transfer already-transferred payment → BadRequest
  const res = await gql(
    `mutation { markPaymentTransferred(paymentId: "${state.paymentId}", transferRef: "DUPLICATE") { id } }`,
    {},
    state.adminToken,
  );
  const errMsg = res.errors?.[0]?.message ?? '';
  if (res.errors && (errMsg.toLowerCase().includes('captured') || errMsg.toLowerCase().includes('bad request') || errMsg.toLowerCase().includes('invalid'))) {
    record('TC_04', 'business-logic', 'PASS', `400/BadRequest — "${errMsg}"`);
  } else {
    record('TC_04', 'business-logic', 'FAIL', `Expected BadRequest for non-captured state, got: ${JSON.stringify(res.errors ?? res.data)}`);
  }
}

async function tc06_paymentHistory() {
  // TC_06: paymentHistory shows all 4 transitions (initial + 3 FSM transitions)
  // The query is scoped to party (admin or patient/caregiver of the payment)
  // Our test admin is not party → but it is admin (role check in service)
  const res = await gql(
    `query { paymentHistory(paymentId: "${state.paymentId}") { id fromStatus toStatus changedBy reason createdAt } }`,
    {},
    state.adminToken,
  );

  if (res.errors) {
    record('TC_06', 'paymentHistory', 'FAIL', `GQL error: ${res.errors[0].message}`);
    return;
  }
  const history = res.data.paymentHistory;
  // Expected: null→pending, pending→held, held→captured, captured→transferred
  const expectedTransitions = [
    { from: null,        to: 'pending'     },
    { from: 'pending',   to: 'held'        },
    { from: 'held',      to: 'captured'    },
    { from: 'captured',  to: 'transferred' },
  ];
  const matches = expectedTransitions.every((exp, i) => {
    const row = history[i];
    return row && (row.fromStatus ?? null) === exp.from && row.toStatus === exp.to;
  });
  if (matches && history.length === 4) {
    record('TC_06', 'paymentHistory', 'PASS', `4 rows found with correct transition sequence`);
  } else {
    record('TC_06', 'paymentHistory', 'FAIL', `Expected 4 rows with correct transitions, got: ${JSON.stringify(history)}`);
  }
}

// ── Cleanup ───────────────────────────────────────────────────────────────────
async function cleanup() {
  console.log('\n=== CLEANUP ===');
  const errors = [];

  const del = async (label, fn) => { try { await fn(); console.log(`  Deleted ${label}`); } catch (e) { errors.push(`${label}: ${e.message}`); } };

  await del('payment_status_history rows', () => prisma.$executeRaw`DELETE FROM payment_status_history WHERE payment_id = ${state.paymentId}::uuid`);
  await del('payment',                     () => prisma.$executeRaw`DELETE FROM payments WHERE id = ${state.paymentId}::uuid`);
  await del('booking',                     () => prisma.$executeRaw`DELETE FROM bookings WHERE id = ${state.bookingId}::uuid`);
  await del('DB admin user',               () => prisma.user.delete({ where: { id: state.adminDbId } }));
  await del('DB patient user',             () => prisma.user.delete({ where: { id: state.patientDbId } }));
  if (state.adminAuthId)   await del('Supabase admin auth',   () => supabaseAdmin.auth.admin.deleteUser(state.adminAuthId));
  if (state.patientAuthId) await del('Supabase patient auth', () => supabaseAdmin.auth.admin.deleteUser(state.patientAuthId));

  if (errors.length) console.warn('  Cleanup warnings:', errors);
  else console.log('  All cleanup completed successfully ✓');
}

// ── Report ────────────────────────────────────────────────────────────────────
function report() {
  const pad = (s, n) => String(s ?? '').padEnd(n);
  console.log('\n' + '='.repeat(85));
  console.log('PYG-285 TC_PYG-S3_04 — Transfer Flow QA Report');
  console.log('='.repeat(85));
  console.log(`${pad('TC_ID', 8)} ${pad('Scope', 18)} ${pad('Result', 8)} Evidence`);
  console.log('-'.repeat(85));
  for (const r of results) {
    const icon = r.result === 'PASS' ? '✅' : r.result === 'FAIL' ? '❌' : '⚠️ ';
    console.log(`${pad(r.id, 8)} ${pad(r.scope, 18)} ${icon} ${pad(r.result, 6)} ${r.evidence}`);
  }
  console.log('-'.repeat(85));
  const pass = results.filter(r => r.result === 'PASS').length;
  const fail = results.filter(r => r.result === 'FAIL').length;
  const blocked = results.filter(r => r.result === 'BLOCKED').length;
  console.log(`TOTAL: ${results.length} | PASS: ${pass} | FAIL: ${fail} | BLOCKED: ${blocked}`);
  console.log('='.repeat(85));
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  try {
    await setup();
    console.log('\n=== TEST EXECUTION ===');
    await tc02_noAuth();
    await tc03_nonAdmin();
    await tc05_adminPayments_beforeTransfer();
    await tc01_happyPath();
    await tc04_notCaptured();
    await tc06_paymentHistory();
  } catch (err) {
    console.error('\nFATAL SETUP ERROR:', err.message);
    if (err.stack) console.error(err.stack);
  } finally {
    await cleanup();
    await prisma.$disconnect();
    report();
  }
})();
