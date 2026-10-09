/**
 * PYG-513 — QA ของ PYG-488: รูปโปรไฟล์ผู้ดูแล (อัปโหลด → รีวิว → แสดงผล)
 *
 * ไล่หัวข้อในการ์ด PYG-513 ผ่าน API จริง (REST อัปโหลด / public profile, GraphQL ที่เหลือ)
 * กับ Postgres ทิ้งได้ใน Docker · Supabase Storage ปลอมแบบ in-memory (เก็บ bytes จริงที่ backend ส่งขึ้น)
 *
 * ★ สถานะตอนเขียน (dev @ b1770e7): PYG-508 (แอดมินอนุมัติ/ปฏิเสธรูป) ยังไม่มีใน backend
 *   - เคสที่ต้อง "กดอนุมัติ/ปฏิเสธ" จริง → it.todo
 *   - สถานะ Approved / Rejected ในตารางแสดงผล ตั้งค่าตรงลง DB (ดู seedApprovedPhoto / setPendingTo)
 *   - `bug(...)` = it.failing: พฤติกรรมที่การ์ดคาดหวังแต่ยังไม่ผ่าน (แก้แล้วเทสจะแดง → เปลี่ยนกลับเป็น it)
 *
 * รัน: PYG513_DATABASE_URL=postgresql://...@127.0.0.1:<port>/<db> npm run test:e2e -- pyg513
 */
import { randomUUID } from 'crypto';
import {
  PROFILE_PHOTOS_BUCKET,
  PROFILE_PHOTO_MAX_BYTES,
} from '../src/identity/kyc/profile-photo.constants';
import { KYC_BUCKET } from '../src/identity/kyc/utils/kyc-storage-path';
import {
  APP2_ICC,
  buildJpeg,
  GPS_SECRET,
  PNG_BYTES,
} from './fixtures/jpeg.fixture';
import {
  bootstrap,
  describeDb,
  SIGNED_PREFIX,
  type GqlBody,
  type Harness,
  type SeededCaregiver,
  type SeededUser,
} from './support/pyg513-e2e';

/**
 * พฤติกรรมที่คาดหวังแต่ยังไม่ผ่าน — ดูเลขการ์ดในชื่อเคส
 * PYG513_SHOW_BUGS=1 → รันเป็น it ธรรมดา เพื่อดูข้อความที่ล้มจริง (ใช้ตอนเขียนรายงาน)
 */
const bug = process.env.PYG513_SHOW_BUGS ? it : it.failing;

const PHOTO_URL = '/api/v1/profile/photo';
const BUCKET = PROFILE_PHOTOS_BUCKET;

const ME = `query { me { id avatarUrl } }`;
const UPDATE_PROFILE = `mutation($input: UpdateProfileInput!) { updateProfile(input: $input) { id avatarUrl } }`;
const SEARCH = `query($input: SearchCaregiverInput) { searchCaregivers(input: $input) { data { id avatarUrl } } }`;
const MY_BOOKING = `query($id: ID!) { myBooking(id: $id) { id caregiver { id avatarUrl } } }`;
const KYC_LIST = `query($input: AdminKycListInput!) { adminKycList(input: $input) { total items { id kycStatus documentCount } } }`;
const KYC_DETAIL = `query($id: ID!) {
  adminKycDetail(caregiverId: $id) {
    caregiver { id kycStatus }
    documents { id docType fileUrl signedUrl }
    reviews { action reason }
  }
}`;
const KYC_STATUS = `query { kycStatus { status documents { id docType fileUrl signedUrl } } }`;
const APPROVE_KYC = `mutation($id: ID!) { approveKyc(caregiverId: $id) { id kycStatus } }`;
const REJECT_KYC = `mutation($input: RejectKycInput!) { rejectKyc(input: $input) { id kycStatus } }`;
const UPLOAD_DOC = `mutation($input: UploadDocumentInput!) { uploadKycDocument(input: $input) { id docType } }`;
const SUBMIT_KYC = `mutation($input: KycInput!) { submitKyc(input: $input) { id kycStatus } }`;
const RESUBMIT_KYC = `mutation($input: KycInput!) { resubmitKyc(input: $input) { id kycStatus } }`;
const SCHEMA_FIELDS = `query { __schema { types { name fields { name } } } }`;

describeDb('PYG-513 · รูปโปรไฟล์ผู้ดูแล: อัปโหลด → รีวิว → แสดงผล (e2e, real DB)', () => {
  let h: Harness;
  let admin: SeededUser;

  beforeAll(async () => {
    h = await bootstrap();
    admin = await h.seedUser('admin', 4);
  });

  afterAll(async () => {
    await h?.close();
  });

  // ─── helpers ─────────────────────────────────────────────────────────────
  const upload = (
    token: string | null,
    bytes: Buffer = buildJpeg(),
    contentType = 'image/jpeg',
  ) => {
    const req = h.http().post(PHOTO_URL);
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req.attach('photo', bytes, { filename: 'photo.jpg', contentType });
  };

  const avatarOf = async (userId: string) =>
    (await h.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { avatarUrl: true } })).avatarUrl;

  const photoDocs = (caregiverId: string) =>
    h.prisma.kycDocument.findMany({
      where: { caregiverId, documentType: 'profile_photo' },
      orderBy: { uploadedAt: 'asc' },
    });

  const signedOf = (path: string, bucket = BUCKET) => `${SIGNED_PREFIX}${bucket}/${path}?token=`;

  /**
   * "รูปเดิมที่อนุมัติแล้ว" — ตั้งตรงลง DB เพราะยังไม่มี mutation อนุมัติ (PYG-508)
   * รูปแบบตามที่ PYG-507 ออกแบบไว้: users.avatar_url = path ของรูปที่อนุมัติ + แถวเอกสาร approved
   */
  async function seedApprovedPhoto(cg: SeededCaregiver) {
    const path = `${cg.id}/profile-approved-${randomUUID()}.jpg`;
    h.storage.put(BUCKET, path, buildJpeg({ exif: false, xmp: false }));
    await h.prisma.user.update({ where: { id: cg.id }, data: { avatarUrl: path } });
    await h.prisma.kycDocument.create({
      data: {
        caregiverId: cg.caregiverId,
        userId: cg.id,
        documentType: 'profile_photo',
        fileUrl: path,
        fileName: 'approved.jpg',
        fileSize: 100,
        mimeType: 'image/jpeg',
        reviewStatus: 'approved',
        reviewedAt: new Date(),
      },
    });
    return path;
  }

  /** อัปโหลดรูปใหม่ (ได้สถานะ pending) แล้วคืน path ที่เก็บ */
  async function uploadPending(cg: SeededCaregiver) {
    const res = await upload(cg.token);
    expect(res.status).toBe(201);
    expect(res.body.reviewStatus).toBe('pending');
    const docs = await photoDocs(cg.caregiverId);
    return docs.filter((d) => d.reviewStatus === 'pending')[0].fileUrl;
  }

  /** สิ่งที่ผู้ใช้ทั่วไป (ผู้จอง) เห็น 3 ที่ตามการ์ด: ผลค้นหา / ใบจอง / public profile */
  async function publicViews(cg: SeededCaregiver) {
    const patient = await h.seedUser('patient');
    const booking = await h.prisma.booking.create({
      data: {
        patientId: patient.id,
        caregiverId: cg.caregiverId,
        serviceType: 'general_care',
        timeSlot: 'morning',
        startTime: new Date('1970-01-01T09:00:00Z'),
        durationHours: 2,
        locationAddress: 'PYG-513 test address',
        bookingDate: new Date(Date.now() + 30 * 86_400_000),
      },
      select: { id: true },
    });

    const search = await h.gql(patient.token, SEARCH, { input: { province: cg.province } });
    expect(search.errors).toBeUndefined();
    const hit = (search.data!.searchCaregivers.data as { id: string; avatarUrl: string | null }[]).find(
      (c) => c.id === cg.caregiverId,
    );
    expect(hit).toBeDefined();

    const myBooking = await h.gql(patient.token, MY_BOOKING, { id: booking.id });
    expect(myBooking.errors).toBeUndefined();

    const pub = await h
      .http()
      .get(`/api/v1/caregivers/${cg.caregiverId}/public`)
      .set('Authorization', `Bearer ${patient.token}`);
    expect(pub.status).toBe(200);

    return {
      search: hit!.avatarUrl ?? null,
      booking: (myBooking.data!.myBooking.caregiver.avatarUrl as string | null) ?? null,
      publicProfile: (pub.body.avatar_url as string | null) ?? null,
    };
  }

  const ALL_NULL = { search: null, booking: null, publicProfile: null };

  // ═══ 1. อัปโหลด ═══════════════════════════════════════════════════════════

  it('_01 ผู้ดูแลอัปโหลด → pending เข้าคิวรีวิว · users.avatar_url ไม่ถูกแตะ · kycStatus เดิม', async () => {
    const cg = await h.seedCaregiver('verified');
    const res = await upload(cg.token);

    expect(res.status).toBe(201);
    expect(res.body.reviewStatus).toBe('pending');

    const docs = await photoDocs(cg.caregiverId);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ reviewStatus: 'pending', userId: cg.id, mimeType: 'image/jpeg' });
    expect(docs[0].fileUrl.startsWith(`${cg.id}/profile-`)).toBe(true);
    expect(h.storage.has(BUCKET, docs[0].fileUrl)).toBe(true);
    // เจ้าตัวได้ signed URL ของรูปที่เพิ่งอัป ไม่ใช่ path ดิบ
    expect(res.body.photoUrl.startsWith(signedOf(docs[0].fileUrl))).toBe(true);

    expect(await avatarOf(cg.id)).toBeNull();
    const row = await h.prisma.caregiver.findUniqueOrThrow({ where: { id: cg.caregiverId } });
    expect(row.kycStatus).toBe('verified');
  });

  it('_01b ผู้ดูแลอัปโหลดซ้ำตอนยัง pending → คิวมีใบเดียว ไฟล์ใบเก่าถูกลบ', async () => {
    const cg = await h.seedCaregiver('verified');
    const first = await uploadPending(cg);
    const second = await uploadPending(cg);

    expect(second).not.toBe(first);
    const docs = await photoDocs(cg.caregiverId);
    expect(docs.map((d) => d.fileUrl)).toEqual([second]);
    expect(h.storage.has(BUCKET, first)).toBe(false);
    expect(h.storage.has(BUCKET, second)).toBe(true);
  });

  it('_01c บัญชี role ผู้ดูแลที่ยังไม่มีแถว caregivers (ยังไม่ส่ง KYC) → 403 อัปโหลดไม่ได้', async () => {
    const user = await h.seedUser('newcg', 2);
    const res = await upload(user.token);

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/ไม่พบโปรไฟล์ผู้ดูแล/);
    expect(h.storage.paths(BUCKET).some((p) => p.startsWith(`${user.id}/`))).toBe(false);
  });

  it.each([
    [1, 'ผู้รับบริการ'],
    [3, 'แอดมิน'],
    [4, 'Super Admin'],
  ])('_02 role %i (%s) เปลี่ยนรูป → แสดงทันที ไม่เข้าคิว', async (role) => {
    const user = await h.seedUser('user', role);
    const res = await upload(user.token);

    expect(res.status).toBe(201);
    expect(res.body.reviewStatus).toBe('approved');

    const stored = await avatarOf(user.id);
    expect(stored).toMatch(new RegExp(`^${user.id}/profile-.+\\.jpg$`));
    expect(await h.prisma.kycDocument.count({ where: { userId: user.id } })).toBe(0);

    const me = await h.gql(user.token, ME);
    expect(me.errors).toBeUndefined();
    expect((me.data!.me.avatarUrl as string).startsWith(signedOf(stored!))).toBe(true);
  });

  it('_02b role อื่นเปลี่ยนรูปซ้ำ → ไฟล์เดิมใน bucket ถูกลบ เหลือรูปล่าสุดใบเดียว', async () => {
    const user = await h.seedUser('user', 1);
    await upload(user.token);
    const first = (await avatarOf(user.id))!;
    await upload(user.token);
    const second = (await avatarOf(user.id))!;

    expect(second).not.toBe(first);
    expect(h.storage.paths(BUCKET).filter((p) => p.startsWith(`${user.id}/`))).toEqual([second]);
  });

  it.each([
    ['ผู้ดูแล (เข้าคิว)', 2],
    ['ผู้รับบริการ (แสดงทันที)', 1],
  ])('_03 ไฟล์ที่เก็บใน bucket ไม่มี EXIF / GPS — %s', async (_l, role) => {
    const user = role === 2 ? await h.seedCaregiver('verified') : await h.seedUser('user', 1);
    const original = buildJpeg({ exif: true, xmp: true, icc: true, trailer: true });
    expect(original.includes(GPS_SECRET)).toBe(true); // ต้นฉบับมีพิกัดจริง
    expect(original.includes(Buffer.from('+13.7768+100.5793', 'latin1'))).toBe(true);

    expect((await upload(user.token, original)).status).toBe(201);

    const [path] = h.storage.paths(BUCKET).filter((p) => p.startsWith(`${user.id}/`));
    const stored = h.storage.get(BUCKET, path)!;
    expect(stored.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(stored.includes(GPS_SECRET)).toBe(false); // Exif + XMP
    expect(stored.includes(Buffer.from('Exif', 'latin1'))).toBe(false);
    expect(stored.includes(Buffer.from('+13.7768+100.5793', 'latin1'))).toBe(false); // motion photo ต่อท้าย
    expect(stored.includes(APP2_ICC)).toBe(true); // โปรไฟล์สีต้องรอด
    expect(stored.length).toBeLessThan(original.length);
  });

  it('_04 ไฟล์ที่ไม่รับ: ไม่ใช่ JPEG / ปลอม MIME / ใหญ่เกิน / ไม่แนบ / ไม่มี token', async () => {
    const cg = await h.seedCaregiver('verified');

    expect((await upload(cg.token, PNG_BYTES, 'image/png')).status).toBe(415);
    expect((await upload(cg.token, PNG_BYTES, 'image/jpeg')).status).toBe(415); // อ้างว่า JPEG แต่ไม่ใช่
    const big = Buffer.concat([buildJpeg(), Buffer.alloc(PROFILE_PHOTO_MAX_BYTES)]);
    expect((await upload(cg.token, big)).status).toBe(413);
    const none = await h.http().post(PHOTO_URL).set('Authorization', `Bearer ${cg.token}`);
    expect(none.status).toBe(400);
    expect((await upload(null)).status).toBe(401);

    expect(await photoDocs(cg.caregiverId)).toHaveLength(0);
    expect(h.storage.paths(BUCKET).some((p) => p.startsWith(`${cg.id}/`))).toBe(false);
  });

  it.each([
    ['ผู้ดูแล', 2],
    ['ผู้รับบริการ', 1],
  ])('_05 updateProfile(avatarUrl) ถูกปฏิเสธ — %s', async (_l, role) => {
    const user = role === 2 ? await h.seedCaregiver('verified') : await h.seedUser('user', 1);
    const res = await h.gql(user.token, UPDATE_PROFILE, {
      input: { avatarUrl: 'https://evil.example/someone-else.jpg' },
    });

    expect(res.data).toBeNull();
    expect(res.errors?.[0]?.message).toMatch(/POST \/api\/v1\/profile\/photo/);
    expect(await avatarOf(user.id)).toBeNull();
  });

  // ═══ 2. ตาราง "การแสดงผลต่อผู้ใช้ทั่วไป" (ผลค้นหา / ใบจอง / public profile) ═══

  it('_06 Pending ไม่มีรูปเดิม → Placeholder ทั้ง 3 ที่', async () => {
    const cg = await h.seedCaregiver('verified');
    await uploadPending(cg);

    expect(await publicViews(cg)).toEqual(ALL_NULL);
  });

  it('_07 Pending มีรูปเดิมที่อนุมัติ → ทั้ง 3 ที่ยังเป็นรูปเดิม ไม่ใช่รูปใหม่', async () => {
    const cg = await h.seedCaregiver('verified');
    const approved = await seedApprovedPhoto(cg);
    const pending = await uploadPending(cg);

    const views = await publicViews(cg);
    for (const value of Object.values(views)) {
      expect(value).toContain(approved);
      expect(value).not.toContain(pending);
    }
    expect(await avatarOf(cg.id)).toBe(approved);
  });

  bug('_07b [PYG-509] รูปที่อนุมัติแล้วต้องออกเป็น signed URL ทั้ง 3 ที่ — ตอนนี้ส่ง storage path ดิบ', async () => {
    const cg = await h.seedCaregiver('verified');
    const approved = await seedApprovedPhoto(cg);

    const views = await publicViews(cg);
    expect(views.search?.startsWith(signedOf(approved))).toBe(true);
    expect(views.booking?.startsWith(signedOf(approved))).toBe(true);
    expect(views.publicProfile?.startsWith(signedOf(approved))).toBe(true);
  });

  bug('_08 [PYG-508] Approved → รูปใหม่: ต้องมี mutation ให้แอดมินอนุมัติ/ปฏิเสธรูปโปรไฟล์', async () => {
    const res = await h.gql(admin.token, SCHEMA_FIELDS);
    const mutations = (res.data!.__schema.types as { name: string; fields: { name: string }[] | null }[])
      .find((t) => t.name === 'Mutation')!
      .fields!.map((f) => f.name);

    expect(mutations.some((name) => /photo/i.test(name))).toBe(true);
  });

  it.todo('_08b [รอ PYG-508] แอดมินอนุมัติรูป → ผลค้นหา / ใบจอง / public profile เป็นรูปใหม่');

  it('_09 Rejected มีรูปเดิม → ทั้ง 3 ที่ยังเป็นรูปเดิม (สถานะ rejected ตั้งตรงลง DB)', async () => {
    const cg = await h.seedCaregiver('verified');
    const approved = await seedApprovedPhoto(cg);
    const pending = await uploadPending(cg);
    await h.prisma.kycDocument.updateMany({
      where: { fileUrl: pending },
      data: { reviewStatus: 'rejected', reviewedAt: new Date() },
    });

    const views = await publicViews(cg);
    for (const value of Object.values(views)) {
      expect(value).toContain(approved);
      expect(value).not.toContain(pending);
    }
  });

  it('_10 Rejected ไม่มีรูปเดิม → Placeholder ทั้ง 3 ที่ (สถานะ rejected ตั้งตรงลง DB)', async () => {
    const cg = await h.seedCaregiver('verified');
    const pending = await uploadPending(cg);
    await h.prisma.kycDocument.updateMany({
      where: { fileUrl: pending },
      data: { reviewStatus: 'rejected', reviewedAt: new Date() },
    });

    expect(await publicViews(cg)).toEqual(ALL_NULL);
  });

  bug('_10b [PYG-508] ผู้ดูแลเห็นสถานะ/เหตุผลที่รูปถูกปฏิเสธ — ต้องมี field ให้ query', async () => {
    const res = await h.gql(admin.token, SCHEMA_FIELDS);
    const types = res.data!.__schema.types as { name: string; fields: { name: string }[] | null }[];
    const fieldsOf = (name: string) => types.find((t) => t.name === name)?.fields?.map((f) => f.name) ?? [];
    const exposed = [...fieldsOf('Caregiver'), ...fieldsOf('KycStatusPayload'), ...fieldsOf('Query')];

    expect(exposed.some((name) => /photo/i.test(name))).toBe(true);
  });

  it.todo('_10c [รอ PYG-508] แอดมินปฏิเสธรูปพร้อมเหตุผล → ผู้ดูแลเห็นเหตุผล + บันทึกใน kyc_reviews (document_id)');

  // ═══ 3. เพิ่มเติม ═════════════════════════════════════════════════════════

  it('_11 ผู้ดูแล verified เปลี่ยนรูป → kycStatus ยังเป็น verified และยังค้นหาเจอ', async () => {
    const cg = await h.seedCaregiver('verified');
    await uploadPending(cg);

    const row = await h.prisma.caregiver.findUniqueOrThrow({ where: { id: cg.caregiverId } });
    expect(row).toMatchObject({ kycStatus: 'verified', isSearchable: true });
    expect((await publicViews(cg)).search).toBeNull(); // เจอในผลค้นหา (publicViews ยืนยันแล้ว) แต่ยังไม่มีรูป
  });

  bug('_11b [PYG-508 / PYG-546] ผู้ดูแล verified เปลี่ยนรูป → ต้องโผล่ในคิวแอดมิน', async () => {
    const cg = await h.seedCaregiver('verified');
    await uploadPending(cg);

    const res = await h.gql(admin.token, KYC_LIST, { input: { status: 'pending', limit: 100 } });
    expect(res.errors).toBeUndefined();
    const ids = (res.data!.adminKycList.items as { id: string }[]).map((i) => i.id);
    expect(ids).toContain(cg.caregiverId);
  });

  it('_11c [PYG-546] ใช้ approveKyc / rejectKyc เดิมกับรูปของผู้ดูแล verified ไม่ได้ → Conflict รูปยัง pending', async () => {
    const cg = await h.seedCaregiver('verified');
    const pending = await uploadPending(cg);

    const approve = await h.gql(admin.token, APPROVE_KYC, { id: cg.caregiverId });
    const reject = await h.gql(admin.token, REJECT_KYC, {
      input: { caregiverId: cg.caregiverId, reasons: [{ title: 'ใบหน้าไม่ตรงกับบัตร' }] },
    });

    expect(approve.errors?.[0]).toMatchObject({
      message: 'Cannot approve KYC: already verified',
      extensions: { status: 409 },
    });
    expect(reject.errors?.[0]).toMatchObject({
      message: 'Cannot reject KYC: already verified',
      extensions: { status: 409 },
    });
    const [doc] = await photoDocs(cg.caregiverId);
    expect(doc).toMatchObject({ fileUrl: pending, reviewStatus: 'pending' });
    expect(await avatarOf(cg.id)).toBeNull();
    const row = await h.prisma.caregiver.findUniqueOrThrow({ where: { id: cg.caregiverId } });
    expect(row.kycStatus).toBe('verified');
  });

  it.todo('_11d [รอ PYG-508] kycStatus ยังเป็น verified หลังแอดมินอนุมัติ / ปฏิเสธรูป');

  /** เอกสาร KYC 1 ใบ (บัตรประชาชน) ของผู้ดูแล — ไฟล์อยู่ใน bucket kyc-documents โฟลเดอร์ supabase uid */
  async function attachIdCard(cg: SeededCaregiver) {
    const path = `${cg.supabaseUid}/id-card-front.jpg`;
    h.storage.put(KYC_BUCKET, path, buildJpeg());
    await h.prisma.kycDocument.create({
      data: {
        caregiverId: cg.caregiverId,
        userId: cg.id,
        documentType: 'id_card_front',
        fileUrl: path,
        fileName: 'id-card-front.jpg',
        fileSize: 100,
        mimeType: 'image/jpeg',
      },
    });
    return path;
  }

  const idCardOf = (body: GqlBody, root: 'adminKycDetail' | 'kycStatus') =>
    (body.data?.[root]?.documents as { docType: string; signedUrl: string | null; fileUrl: string }[] | undefined)?.find(
      (d) => d.docType === 'id_card_front',
    );

  it('_12 (ตัวเทียบ) ยังไม่อัปโหลดรูปโปรไฟล์ → แอดมินเปิดรายละเอียด KYC ได้ เห็นบัตรเป็น signed URL', async () => {
    const cg = await h.seedCaregiver('verified');
    const idPath = await attachIdCard(cg);

    const res = await h.gql(admin.token, KYC_DETAIL, { id: cg.caregiverId });
    expect(res.errors).toBeUndefined();
    const idCard = idCardOf(res, 'adminKycDetail')!;
    expect(idCard.signedUrl?.startsWith(signedOf(idPath, KYC_BUCKET))).toBe(true);
    expect(idCard.fileUrl).toBe(''); // ไม่คืน path ดิบ
  });

  bug.each(['verified', 'pending'] as const)(
    '_12b [PYG-547] ผู้ดูแล (KYC %s) อัปโหลดรูปโปรไฟล์แล้ว → แอดมินยังต้องเปิดรายละเอียด KYC ได้',
    async (kycStatus) => {
      const cg = await h.seedCaregiver(kycStatus);
      const idPath = await attachIdCard(cg);
      expect((await upload(cg.token)).status).toBe(201);

      const res = await h.gql(admin.token, KYC_DETAIL, { id: cg.caregiverId });
      expect(res.errors).toBeUndefined();
      expect(idCardOf(res, 'adminKycDetail')?.signedUrl?.startsWith(signedOf(idPath, KYC_BUCKET))).toBe(true);
    },
  );

  bug('_12c [PYG-547] ผู้ดูแลอัปโหลดรูปโปรไฟล์แล้ว → หน้าสถานะ KYC ของตัวเอง (kycStatus) ยังต้องเปิดได้', async () => {
    const cg = await h.seedCaregiver('verified');
    const idPath = await attachIdCard(cg);
    expect((await upload(cg.token)).status).toBe(201);

    const res = await h.gql(cg.token, KYC_STATUS);
    expect(res.errors).toBeUndefined();
    expect(idCardOf(res, 'kycStatus')?.signedUrl?.startsWith(signedOf(idPath, KYC_BUCKET))).toBe(true);
  });

  it('_13 ไม่มี storage path ดิบใน response ของเจ้าของรูป (อัปโหลด / me) ทั้งผู้ดูแลและ role อื่น', async () => {
    const cg = await h.seedCaregiver('verified');
    const user = await h.seedUser('user', 1);
    const bodies = [
      (await upload(cg.token)).body,
      (await upload(user.token)).body,
      await h.gql(cg.token, ME),
      await h.gql(user.token, ME),
    ];

    for (const body of bodies) {
      const withoutSigned = JSON.stringify(body).split(SIGNED_PREFIX).map((part, i) => (i === 0 ? part : part.replace(/^[^"]*/, ''))).join('');
      expect(withoutSigned).not.toMatch(/profile-[0-9a-f-]+\.jpg/);
    }
  });

  it('_13b อายุ signed URL: รูปโปรไฟล์ 3600 วินาที · เอกสาร KYC 900 วินาที (ไม่ใช่ลิงก์ถาวร)', async () => {
    const cg = await h.seedCaregiver('verified');
    await attachIdCard(cg);
    const user = await h.seedUser('user', 1);
    h.storage.signCalls.length = 0;

    await upload(user.token);
    await h.gql(user.token, ME);
    await h.gql(admin.token, KYC_DETAIL, { id: cg.caregiverId });

    const ttl = (bucket: string) => [...new Set(h.storage.signCalls.filter((c) => c.bucket === bucket).map((c) => c.ttl))];
    expect(ttl(BUCKET)).toEqual([3600]);
    expect(ttl(KYC_BUCKET)).toEqual([900]);
  });

  // ═══ 4. KYC flow เดิม (ส่งบัตร → approve / reject) ═════════════════════════

  const kycInput = (documentIds: string[]) => ({
    fullName: 'สมหญิง ทดสอบ',
    idCardNumber: '1101700230708',
    phone: '0812345678',
    skills: ['elder_care'],
    experienceYears: 3,
    documentIds,
  });

  /** ผู้ดูแลใหม่ลงทะเบียนเอกสารบัตร → submitKyc ผ่าน API จริง */
  async function submitKycFlow() {
    const user = await h.seedUser('newcg', 2);
    const path = `${user.supabaseUid}/id-card-front.jpg`;
    h.storage.put(KYC_BUCKET, path, buildJpeg());

    const doc = await h.gql(user.token, UPLOAD_DOC, {
      input: { docType: 'id_card_front', fileUrl: path, fileName: 'id.jpg', fileSize: 1000, mimeType: 'image/jpeg' },
    });
    expect(doc.errors).toBeUndefined();
    const docId = doc.data!.uploadKycDocument.id as string;

    const submit = await h.gql(user.token, SUBMIT_KYC, { input: kycInput([docId]) });
    expect(submit.errors).toBeUndefined();
    expect(submit.data!.submitKyc.kycStatus).toBe('pending');
    return { user, path, docId, caregiverId: submit.data!.submitKyc.id as string };
  }

  it('_14 ส่งบัตร → เข้าคิว → แอดมินเปิดดู → approve → verified + kyc_reviews (document_id ว่าง)', async () => {
    const { path, caregiverId } = await submitKycFlow();

    const list = await h.gql(admin.token, KYC_LIST, { input: { status: 'pending', limit: 100 } });
    expect((list.data!.adminKycList.items as { id: string }[]).map((i) => i.id)).toContain(caregiverId);

    const detail = await h.gql(admin.token, KYC_DETAIL, { id: caregiverId });
    expect(detail.errors).toBeUndefined();
    expect(idCardOf(detail, 'adminKycDetail')?.signedUrl?.startsWith(signedOf(path, KYC_BUCKET))).toBe(true);

    const approve = await h.gql(admin.token, APPROVE_KYC, { id: caregiverId });
    expect(approve.errors).toBeUndefined();
    expect(approve.data!.approveKyc.kycStatus).toBe('verified');

    const reviews = await h.prisma.kycReview.findMany({ where: { caregiverId } });
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ action: 'approved', reviewerId: admin.id, documentId: null });
  });

  it('_15 ส่งบัตร → reject พร้อมเหตุผล → rejected → resubmitKyc → pending อีกครั้ง', async () => {
    const { user, docId, caregiverId } = await submitKycFlow();

    const reject = await h.gql(admin.token, REJECT_KYC, {
      input: { caregiverId, reasons: [{ title: 'รูปบัตรไม่ชัด', documentType: 'id_card_front' }] },
    });
    expect(reject.errors).toBeUndefined();
    expect(reject.data!.rejectKyc.kycStatus).toBe('rejected');

    const reviews = await h.prisma.kycReview.findMany({ where: { caregiverId } });
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ action: 'rejected', reason: 'รูปบัตรไม่ชัด', documentId: null });

    const resubmit = await h.gql(user.token, RESUBMIT_KYC, { input: kycInput([docId]) });
    expect(resubmit.errors).toBeUndefined();
    expect(resubmit.data!.resubmitKyc.kycStatus).toBe('pending');
  });
});
