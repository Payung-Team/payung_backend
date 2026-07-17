-- AlterTable (payouts = 0 rows → NOT NULL ปลอดภัย ไม่ต้อง default)
ALTER TABLE "payouts"
    ADD COLUMN "gross_amount" DECIMAL(10,2) NOT NULL,
    ADD COLUMN "fee_rate" DECIMAL(5,4) NOT NULL,
    ADD COLUMN "platform_fee" DECIMAL(10,2) NOT NULL;

-- AddConstraint (money invariant — บังคับระดับ DB)
ALTER TABLE "payouts"
    ADD CONSTRAINT "payouts_amount_split_check"
    CHECK (
        "gross_amount" = "platform_fee" + "amount"
        AND "platform_fee" >= 0
        AND "amount" >= 0
        AND "fee_rate" >= 0
    );
