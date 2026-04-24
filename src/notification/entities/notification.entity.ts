/**
 * Notification Entity — GraphQL type สำหรับ in-app notification (PYG-95)
 *
 * ไฟล์นี้คือ "พิมพ์เขียว" ที่บอก GraphQL ว่า notification มีหน้าตาแบบไหน
 * client จะ query field ตามที่กำหนดไว้ที่นี่
 *
 * @ObjectType() = output type (ข้อมูลที่ส่งกลับ client)
 * @Field()      = field ที่ client ขอได้
 */
import { ObjectType, Field, ID } from '@nestjs/graphql';
import { NotificationType } from './notification-type.enum';

@ObjectType()
export class Notification {
  /** UUID ของ notification */
  @Field(() => ID)
  id!: string;

  /** user ที่ได้รับ notification */
  @Field({ description: 'Recipient user ID' })
  userId!: string;

  /** ประเภท notification (enum) */
  @Field(() => NotificationType, { description: 'Notification category' })
  type!: NotificationType;

  /** หัวข้อสั้นๆ ที่แสดงใน list */
  @Field({ description: 'Short title shown in notification list' })
  title!: string;

  /** เนื้อหารายละเอียด */
  @Field({ description: 'Body / detail of the notification' })
  body!: string;

  /**
   * metadata เพิ่มเติม — serialize เป็น JSON string ก่อนส่งให้ client
   * (ยังไม่มี graphql-type-json ใน deps — ถ้ามีแล้วค่อยเปลี่ยนเป็น GraphQLJSON scalar)
   * ตัวอย่างค่า: '{"caregiverId":"...","bookingId":"..."}'
   * client parse ด้วย JSON.parse() เมื่อต้องการใช้
   */
  @Field(() => String, { nullable: true, description: 'Optional JSON-stringified payload' })
  data?: string;

  /** อ่านแล้วหรือยัง */
  @Field({ description: 'Whether the notification has been read' })
  isRead!: boolean;

  /** เวลาที่อ่าน — null ถ้ายังไม่อ่าน */
  @Field({ nullable: true, description: 'When the notification was read (null if unread)' })
  readAt?: Date;

  /** เวลาที่สร้าง */
  @Field({ description: 'When the notification was created' })
  createdAt!: Date;
}
