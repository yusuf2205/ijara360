-- M5: staff Telegram linking, trusted devices and Telegram approval of new-device logins from the internet.
ALTER TABLE "users" ADD COLUMN "telegram_user_id" VARCHAR(30), ADD COLUMN "telegram_linked_at" TIMESTAMPTZ(3);
CREATE UNIQUE INDEX "users_telegram_user_id_key" ON "users"("telegram_user_id");
ALTER TABLE "users" ADD CONSTRAINT "user_telegram_linked" CHECK (("telegram_user_id" IS NULL) = ("telegram_linked_at" IS NULL));

CREATE TABLE "staff_telegram_links" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "telegram_user_id" VARCHAR(30),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "staff_telegram_links_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "staff_telegram_links_token_hash_key" ON "staff_telegram_links"("token_hash");
CREATE INDEX "staff_telegram_links_user_id_idx" ON "staff_telegram_links"("user_id");
CREATE INDEX "staff_telegram_links_telegram_user_id_idx" ON "staff_telegram_links"("telegram_user_id");

CREATE TABLE "trusted_devices" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "platform" VARCHAR(20) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "trusted_devices_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "trusted_device_platform" CHECK ("platform" IN ('WEB','ANDROID','IOS','WINDOWS'))
);
CREATE UNIQUE INDEX "trusted_devices_token_hash_key" ON "trusted_devices"("token_hash");
CREATE INDEX "trusted_devices_user_id_idx" ON "trusted_devices"("user_id");

CREATE TABLE "login_approvals" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "poll_token_hash" CHAR(64) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "platform" VARCHAR(20) NOT NULL,
    "device_name" VARCHAR(120) NOT NULL,
    "remembered" BOOLEAN NOT NULL DEFAULT false,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "decided_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "login_approvals_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "login_approval_status" CHECK ("status" IN ('PENDING','APPROVED','DENIED','USED')),
    CONSTRAINT "login_approval_platform" CHECK ("platform" IN ('WEB','ANDROID','IOS','WINDOWS'))
);
CREATE UNIQUE INDEX "login_approvals_poll_token_hash_key" ON "login_approvals"("poll_token_hash");
CREATE INDEX "login_approvals_user_id_idx" ON "login_approvals"("user_id");

ALTER TABLE "staff_telegram_links" ADD CONSTRAINT "staff_telegram_links_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "trusted_devices" ADD CONSTRAINT "trusted_devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "login_approvals" ADD CONSTRAINT "login_approvals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
