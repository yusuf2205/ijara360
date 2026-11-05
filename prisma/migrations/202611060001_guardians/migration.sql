-- Parent access (owner's decision 2026-11-05): a parent follows a resident's rent in the Telegram bot.
-- Only staff connect a parent (one-time bot link); the parent gets payment reminders and overdue notices,
-- payments with the receipt number, new charges, and move-in, transfer, end-of-stay and check-out notices.
-- Never location or documents. Access ends when staff disconnect the parent, the parent leaves in the bot,
-- or the resident checks out; then the phone and the Telegram id are cleared.
CREATE TABLE "guardians" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "resident_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "phone" VARCHAR(16),
    "telegram_user_id" VARCHAR(30),
    "lang" VARCHAR(2) NOT NULL DEFAULT 'ru',
    "created_by_id" UUID,
    "linked_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "guardians_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "guardians_lang" CHECK ("lang" IN ('ru','uz')),
    CONSTRAINT "guardians_linked" CHECK ("linked_at" IS NULL OR "telegram_user_id" IS NOT NULL OR "revoked_at" IS NOT NULL)
);
CREATE INDEX "guardians_resident_id_idx" ON "guardians"("resident_id");
CREATE INDEX "guardians_telegram_user_id_idx" ON "guardians"("telegram_user_id") WHERE "revoked_at" IS NULL;
-- One parent's Telegram follows a given resident once.
CREATE UNIQUE INDEX "guardians_resident_telegram_key" ON "guardians"("resident_id", "telegram_user_id") WHERE "revoked_at" IS NULL AND "telegram_user_id" IS NOT NULL;
ALTER TABLE "guardians" ADD CONSTRAINT "guardians_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "guardians" ADD CONSTRAINT "guardians_resident_id_property_id_fkey" FOREIGN KEY ("resident_id", "property_id") REFERENCES "residents"("id", "property_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "guardian_invites" (
    "id" UUID NOT NULL,
    "guardian_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "guardian_invites_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "guardian_invites_token_hash_key" ON "guardian_invites"("token_hash");
CREATE INDEX "guardian_invites_guardian_id_idx" ON "guardian_invites"("guardian_id");
ALTER TABLE "guardian_invites" ADD CONSTRAINT "guardian_invites_guardian_id_fkey" FOREIGN KEY ("guardian_id") REFERENCES "guardians"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A notification now goes to exactly one of: a staff user, a resident's app account, or a parent.
-- (notifications is not part of the deploy data fingerprint; the new column is NULL for existing rows.)
ALTER TABLE "notifications" ADD COLUMN "guardian_id" UUID;
ALTER TABLE "notifications" DROP CONSTRAINT "notification_recipient";
ALTER TABLE "notifications" ADD CONSTRAINT "notification_recipient" CHECK (num_nonnulls("tenant_account_id", "user_id", "guardian_id") = 1);
CREATE INDEX "notifications_guardian_id_created_at_idx" ON "notifications"("guardian_id", "created_at");
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_guardian_id_fkey" FOREIGN KEY ("guardian_id") REFERENCES "guardians"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
