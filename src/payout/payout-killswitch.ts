/**
 * PayoutKillswitch — env-based emergency stop (PYG-331 ก้อน B)
 *
 * env: PAYOUT_KILLSWITCH_ENABLED=false
 *
 * true = worker + reaper ทำงานเปล่า ๆ (log + skip) ไม่ยิง Omise
 * false / unset = ทำงานปกติ
 *
 * ⚠️ เจตนา env เท่านั้น — DB-backed toggle เป็นของ PYG-336 (admin dashboard)
 *    ห้ามเพิ่ม kill-switch ซ้อนใน 331
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class PayoutKillswitch {
  private readonly logger = new Logger(PayoutKillswitch.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * isEnabled — true ถ้า kill-switch ถูก enable → ควร skip
   * รองรับค่าที่พบบ่อย: 'true' / '1' / 'yes' (case-insensitive) → enabled
   */
  isEnabled(): boolean {
    const raw = (this.config.get<string>('PAYOUT_KILLSWITCH_ENABLED') ?? '')
      .trim()
      .toLowerCase();
    return raw === 'true' || raw === '1' || raw === 'yes';
  }

  /**
   * gate — helper สั้น ๆ ให้ worker/reaper เรียก:
   *   if (this.killswitch.gate(logSource)) return;
   *   // ...
   *
   * @returns true ถ้าโดน kill (caller ควร return ทันที), false = ให้ทำต่อ
   */
  gate(source: string): boolean {
    if (this.isEnabled()) {
      this.logger.warn(
        `[${source}] PAYOUT_KILLSWITCH_ENABLED=true → skipping this tick`,
      );
      return true;
    }
    return false;
  }
}
