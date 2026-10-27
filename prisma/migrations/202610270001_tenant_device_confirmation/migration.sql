-- Residents confirm a new-device login in Telegram (or an owner confirms for them). Mirrors the staff
-- trusted_devices / login_approvals tables, keyed to tenant_accounts instead of users.
CREATE TABLE "tenant_trusted_devices" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "platform" VARCHAR(20) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tenant_trusted_devices_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tenant_trusted_device_platform" CHECK ("platform" IN ('WEB','ANDROID','IOS','WINDOWS'))
);
CREATE UNIQUE INDEX "tenant_trusted_devices_token_hash_key" ON "tenant_trusted_devices"("token_hash");
CREATE INDEX "tenant_trusted_devices_account_id_idx" ON "tenant_trusted_devices"("account_id");

CREATE TABLE "tenant_login_approvals" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "poll_token_hash" CHAR(64) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "platform" VARCHAR(20) NOT NULL,
    "device_name" VARCHAR(120) NOT NULL,
    "remembered" BOOLEAN NOT NULL DEFAULT false,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "decided_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tenant_login_approvals_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tenant_login_approval_status" CHECK ("status" IN ('PENDING','APPROVED','DENIED','USED'))
);
CREATE UNIQUE INDEX "tenant_login_approvals_poll_token_hash_key" ON "tenant_login_approvals"("poll_token_hash");
CREATE INDEX "tenant_login_approvals_account_id_idx" ON "tenant_login_approvals"("account_id");

ALTER TABLE "tenant_trusted_devices" ADD CONSTRAINT "tenant_trusted_devices_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "tenant_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tenant_login_approvals" ADD CONSTRAINT "tenant_login_approvals_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "tenant_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
