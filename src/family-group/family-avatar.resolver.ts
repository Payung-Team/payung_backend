import { Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { AvatarUrlService } from '../common/avatar-url.service';
import { FamilyGroup } from './entities/family-group.entity';
import { FamilyGroupMemberItem } from './entities/family-group-member.entity';
import { FamilyGroupActivityActor } from './entities/family-group-activity.entity';
import { FamilyGroupAvatarService } from './family-group-avatar.service';

/**
 * รูปของกลุ่ม — sign เฉพาะตอน client ขอฟิลด์นี้จริง (ทุก query/mutation ที่คืน FamilyGroup)
 * ไฟล์อยู่ที่ path ตายตัวต่อกลุ่ม ไม่มีคอลัมน์ในดีบี (ดู FamilyGroupAvatarService)
 */
@Resolver(() => FamilyGroup)
export class FamilyGroupAvatarResolver {
  constructor(private readonly groupAvatarService: FamilyGroupAvatarService) {}

  @ResolveField(() => String, {
    nullable: true,
    description:
      'รูปกลุ่ม (signed URL หมดอายุ 1 ชม.) — null = ยังไม่ตั้งรูป ให้แสดงตัวอักษรย่อของชื่อกลุ่ม',
  })
  avatarUrl(@Parent() group: FamilyGroup): Promise<string | null> {
    return this.groupAvatarService.signedUrl(group.id);
  }
}

/**
 * Field resolver ของ avatarUrl ในกลุ่มครอบครัว
 *
 * service ใส่ค่าดิบจาก users.avatar_url ลง avatarUrl (อาจเป็น storage path ของ bucket private)
 * resolver นี้ sign ให้ตอน client ขอฟิลด์นี้จริงเท่านั้น — ถ้าส่ง path ดิบออกไป
 * <img> ฝั่ง FE จะโหลดไม่ขึ้นแล้วตกเป็นตัวอักษรย่อ ทั้งที่ผู้ใช้อัปโหลดรูปไว้แล้ว
 */
@Resolver(() => FamilyGroupMemberItem)
export class FamilyGroupMemberAvatarResolver {
  constructor(private readonly avatarUrlService: AvatarUrlService) {}

  @ResolveField(() => String, { nullable: true, description: 'รูปโปรไฟล์' })
  avatarUrl(@Parent() member: FamilyGroupMemberItem): Promise<string | null> {
    return this.avatarUrlService.resolve(member.avatarUrl, member.userId);
  }
}

@Resolver(() => FamilyGroupActivityActor)
export class FamilyGroupActivityActorAvatarResolver {
  constructor(private readonly avatarUrlService: AvatarUrlService) {}

  @ResolveField(() => String, { nullable: true, description: 'รูปโปรไฟล์' })
  avatarUrl(@Parent() actor: FamilyGroupActivityActor): Promise<string | null> {
    return this.avatarUrlService.resolve(actor.avatarUrl, actor.userId);
  }
}
