-- PYG-392: Family group tables (accept invite / join group)
--
-- 4 tables: family_groups, family_group_members, family_group_invites, family_group_activity
-- User.id is text (not uuid), so user FK columns are text.
-- Group PKs are uuid via gen_random_uuid().

-- ─── 1. family_groups ────────────────────────────────────────────────────────
CREATE TABLE "family_groups" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(100) NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "family_groups_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "family_groups"
    ADD CONSTRAINT "family_groups_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── 2. family_group_members ─────────────────────────────────────────────────
CREATE TABLE "family_group_members" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "group_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" VARCHAR(20) NOT NULL DEFAULT 'MEMBER',
    "status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "family_group_members_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "family_group_members"
    ADD CONSTRAINT "family_group_members_group_id_fkey"
    FOREIGN KEY ("group_id") REFERENCES "family_groups"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "family_group_members"
    ADD CONSTRAINT "family_group_members_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "family_group_members_group_id_user_id_key"
    ON "family_group_members"("group_id", "user_id");

CREATE INDEX "idx_fgm_user_id"
    ON "family_group_members"("user_id");

-- ─── 3. family_group_invites ─────────────────────────────────────────────────
CREATE TABLE "family_group_invites" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "group_id" UUID NOT NULL,
    "invited_email" TEXT NOT NULL,
    "invited_by" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "accepted_at" TIMESTAMPTZ(6),
    "accepted_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "family_group_invites_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "family_group_invites"
    ADD CONSTRAINT "family_group_invites_group_id_fkey"
    FOREIGN KEY ("group_id") REFERENCES "family_groups"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "family_group_invites"
    ADD CONSTRAINT "family_group_invites_invited_by_fkey"
    FOREIGN KEY ("invited_by") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "family_group_invites_token_hash_key"
    ON "family_group_invites"("token_hash");

CREATE INDEX "idx_fgi_group_id"
    ON "family_group_invites"("group_id");

-- ─── 4. family_group_activity ────────────────────────────────────────────────
CREATE TABLE "family_group_activity" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "group_id" UUID NOT NULL,
    "actor_id" TEXT,
    "action" VARCHAR(50) NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "family_group_activity_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "family_group_activity"
    ADD CONSTRAINT "family_group_activity_group_id_fkey"
    FOREIGN KEY ("group_id") REFERENCES "family_groups"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "family_group_activity_group_id_created_at_idx"
    ON "family_group_activity"("group_id", "created_at");
