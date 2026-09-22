import { Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { AvatarUrlService } from '../common/avatar-url.service';
import { FamilyGroupMemberItem } from './entities/family-group-member.entity';
import { FamilyGroupActivityActor } from './entities/family-group-activity.entity';

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
