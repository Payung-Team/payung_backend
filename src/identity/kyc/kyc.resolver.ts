/**
 * KycResolver — GraphQL Resolver สำหรับ KYC (Know Your Customer)
 *
 * Resolver คืออะไร?
 * - คือ "ตัวรับ request" จาก GraphQL
 * - เหมือน Controller ใน REST API แต่สำหรับ GraphQL
 * - @Mutation = รับ request ที่เปลี่ยนแปลงข้อมูล (submitKyc)
 * - @Query    = รับ request ที่ดึงข้อมูล (kycStatus, myCaregiverProfile)
 *
 * Guard ที่ใช้:
 * - SupabaseAuthGuard = ตรวจสอบ JWT token ก่อนทุก request
 * - RolesGuard        = เช็คว่า user มี role ที่อนุญาตไหม
 *
 * ลำดับ Guard สำคัญมาก: Auth ก่อน → Roles ทีหลัง
 * เพราะ RolesGuard ต้องการ req.user ที่ SupabaseAuthGuard inject แล้ว
 *
 * Resolver ไม่ควรมี business logic ซับซ้อน — มันแค่รับ request แล้วส่งต่อให้ Service ทำงาน
 */
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { KycService } from './kyc.service';
import { KycDocumentService } from './kyc-document.service';
import { CaregiverService } from './caregiver.service';
import { KycInput } from './dto/kyc.input';
import { KycStatusPayload } from './dto/kyc-status.payload';
import { PayoutAccountInput } from './dto/payout-account.input';
import { PayoutAccountSummary } from './entities/payout-account.entity';
import { PayoutBankOption } from './entities/payout-bank-option.entity';
import {
  OMISE_BANKS,
  accountDigitRule,
} from '../../common/constants/omise-banks.constant';
import { UploadDocumentInput } from './dto/upload-document.input';
import { UpdateCaregiverInput } from './dto/update-caregiver.input';
import { Caregiver } from './entities/caregiver.entity';
import { KycDocument } from './entities/kyc-document.entity';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { FieldLockGuard } from '../../common/guards/field-lock.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { FieldLock } from '../../common/decorators/field-lock.decorator';
import { ROLE_ID } from '../../common/constants/roles.constant';
import {
  CurrentUser,
  AuthUser,
} from '../../common/decorators/current-user.decorator';

@Resolver()
@UseGuards(SupabaseAuthGuard, RolesGuard)
export class KycResolver {
  constructor(
    private kycService: KycService,
    private kycDocumentService: KycDocumentService,
    private caregiverService: CaregiverService,
  ) {}

  /**
   * submitKyc mutation — ใช้ใน GraphQL Playground แบบนี้:
   *
   * mutation {
   *   submitKyc(input: {
   *     fullName: "สมชาย ใจดี"
   *     idCardNumber: "1234567890123"
   *     phone: "0812345678"
   *     skills: ["elder_care", "first_aid"]
   *     experienceYears: 3
   *     hourlyRate: 150.0
   *     bio: "มีประสบการณ์ดูแลผู้สูงอายุ"
   *     documentIds: ["uuid-1", "uuid-2"]
   *   }) {
   *     id kycStatus kycSubmittedAt
   *   }
   * }
   *
   * @CurrentUser() = ดึง user ที่ login อยู่จาก JWT token (inject โดย SupabaseAuthGuard)
   * @Args('input') = ดึงค่า "input" จาก GraphQL arguments
   */
  @Mutation(() => Caregiver, {
    description: 'Submit KYC information (caregiver only)',
  })
  @Roles(2)
  async submitKyc(
    @CurrentUser() user: AuthUser,
    @Args('input') input: KycInput,
  ): Promise<Caregiver> {
    return this.kycService.submitKyc(user, input);
  }

  /**
   * kycStatus query — ดึงข้อมูล KYC status ครบสำหรับ Status Page
   *
   * query {
   *   kycStatus {
   *     status
   *     submittedAt
   *     verifiedAt
   *     rejectedAt
   *     rejectedReason
   *     caregiver { id fullName kycStatus }
   *     documents { id docType fileName signedUrl }
   *   }
   * }
   */
  @Query(() => KycStatusPayload, {
    description: 'Get KYC status with full details for the Status Page',
  })
  @Roles(2) // 2 = caregiver role เท่านั้น
  async kycStatus(@CurrentUser() user: AuthUser): Promise<KycStatusPayload> {
    return this.kycService.getKycStatus(user.id);
  }

  @Query(() => Caregiver, {
    description: 'Get current caregiver profile',
  })
  @Roles(2)
  async myCaregiverProfile(@CurrentUser() user: AuthUser): Promise<Caregiver> {
    return this.caregiverService.findByUserId(user.id);
  }

  // PYG-146: FieldLockGuard เช็คก่อนว่า field ที่จะแก้ถูก admin lock ไว้ไหม
  // class มี @UseGuards(SupabaseAuthGuard, RolesGuard) อยู่แล้ว → Nest รัน class guard
  // ก่อน method guard เสมอ ดังนั้น req.user พร้อมใช้ตอน FieldLockGuard รัน
  // @FieldLock('CAREGIVER_PROFILE') บอก guard ว่า mutation นี้แก้ตาราง caregivers
  @Mutation(() => Caregiver, {
    description: 'Update caregiver profile (verified caregiver only)',
  })
  @Roles(2)
  @UseGuards(FieldLockGuard)
  @FieldLock('CAREGIVER_PROFILE')
  async updateCaregiverProfile(
    @CurrentUser() user: AuthUser,
    @Args('input') input: UpdateCaregiverInput,
  ): Promise<Caregiver> {
    return this.caregiverService.updateProfile(user.id, input);
  }

  /**
   * resubmitKyc mutation — ยื่น KYC ใหม่หลังถูก reject
   *
   * mutation {
   *   resubmitKyc(input: {
   *     fullName: "สมชาย ใจดี"
   *     idCardNumber: "1234567890123"
   *     phone: "0812345678"
   *     skills: ["elder_care"]
   *     experienceYears: 3
   *     hourlyRate: 150.0
   *     documentIds: ["uuid-new-1", "uuid-new-2"]
   *   }) {
   *     id kycStatus kycSubmittedAt resubmitCount
   *   }
   * }
   *
   * Guard:
   * - ต้องเป็น caregiver (role = 2)
   * - ต้อง login อยู่ (SupabaseAuthGuard)
   * - kycStatus ต้องเป็น 'rejected' — ตรวจสอบใน KycService
   *   - none     → BadRequestException
   *   - pending  → ConflictException
   *   - verified → ConflictException
   */
  @Mutation(() => Caregiver, {
    description: 'Resubmit KYC after rejection (caregiver only, status must be rejected)',
  })
  @Roles(2) // 2 = caregiver role เท่านั้น
  async resubmitKyc(
    @CurrentUser() user: AuthUser,
    @Args('input') input: KycInput,
  ): Promise<Caregiver> {
    return this.kycService.resubmitKyc(user, input);
  }

  /**
   * deleteKycDocument mutation — ลบเอกสาร KYC
   *
   * mutation {
   *   deleteKycDocument(documentId: "uuid-here")
   * }
   *
   * Error cases:
   * - document ไม่มีอยู่                        → 404 NotFoundException
   * - document ไม่ใช่ของ user คนนี้             → 403 ForbiddenException
   * - status = pending หรือ verified            → 409 ConflictException
   * - status = rejected หรือ none (ไม่มี link) → ✅ ลบได้
   */
  @Mutation(() => Boolean, {
    description: 'Delete a KYC document (allowed only when status is rejected or none)',
  })
  @Roles(2) // 2 = caregiver role เท่านั้น
  async deleteKycDocument(
    @CurrentUser() user: AuthUser,
    @Args('documentId', { type: () => String }) documentId: string,
  ): Promise<boolean> {
    return this.kycService.deleteKycDocument(documentId, user.id);
  }
  @Mutation(() => KycDocument, {
    description: 'Register a KYC document record after uploading to storage',
  })
  @Roles(2)
  async uploadKycDocument(
    @CurrentUser() user: AuthUser,
    @Args('input') input: UploadDocumentInput,
  ): Promise<KycDocument> {
    return this.kycDocumentService.create({
      userId: user.id,
      documentType: input.docType,
      fileUrl: input.fileUrl,
      fileName: input.fileName,
      fileSize: input.fileSize,
      mimeType: input.mimeType,
    });
  }

  /**
   * updatePayoutAccount mutation — PYG-266: caregiver ที่ verified แล้วเพิ่ม/แก้บัญชีรับเงินเอง
   * (นอก flow submitKyc/resubmitKyc ที่ถูกบล็อกไว้เมื่อ kycStatus='verified')
   */
  @Mutation(() => PayoutAccountSummary, {
    description: 'Add or update payout bank account (verified caregiver only)',
  })
  @Roles(ROLE_ID.CAREGIVER)
  async updatePayoutAccount(
    @CurrentUser() user: AuthUser,
    @Args('input') input: PayoutAccountInput,
  ): Promise<PayoutAccountSummary> {
    return this.kycService.updatePayoutAccount(user, input);
  }

  /**
   * payoutBankOptions — รายชื่อธนาคาร + กฎความยาวเลขบัญชี ให้ FE ดึงไปสร้าง dropdown
   *
   * มีไว้เพื่อฆ่า hardcode ซ้ำสองที่ (TASK 4): เดิม FE ตรึง "10 หลัก" ไว้เอง
   * ขณะที่ชุดธนาคารฝั่ง BE มีออมสิน/ธ.ก.ส. ที่ไม่ใช่ 10 หลัก → กรอกไม่ผ่านทั้งคู่
   *
   * ไม่แตะ DB ไม่มีข้อมูลส่วนบุคคล — เป็น static config ล้วน จึงไม่จำกัด role
   * (ยังต้องผ่าน SupabaseAuthGuard ระดับคลาสอยู่)
   */
  @Query(() => [PayoutBankOption], {
    description:
      'รายชื่อธนาคารที่ใช้เป็นบัญชีรับเงินได้ + กฎความยาวเลขบัญชี — FE ต้องดึงจากที่นี่ ห้าม hardcode',
  })
  payoutBankOptions(): PayoutBankOption[] {
    return OMISE_BANKS.map((bank) => {
      const { min, max } = accountDigitRule(bank.code);
      return {
        code: bank.code,
        nameTh: bank.nameTh,
        nameEn: bank.nameEn,
        minDigits: min,
        maxDigits: max,
        exactDigits: bank.digits ? [...bank.digits] : null,
      };
    });
  }
}


