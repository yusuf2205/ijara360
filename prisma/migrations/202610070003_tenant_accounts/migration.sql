-- M5: tenant accounts, one-time invites and tenant sessions (separate from staff sessions).
-- CreateTable
CREATE TABLE "tenant_accounts" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "resident_id" UUID NOT NULL,
    "phone" VARCHAR(16) NOT NULL,
    "password_hash" TEXT,
    "telegram_user_id" VARCHAR(30),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "activated_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_invites" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "channel" VARCHAR(20) NOT NULL,
    "created_by_id" UUID,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_sessions" (
    "id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "account_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "device_name" VARCHAR(120),
    "platform" VARCHAR(20) NOT NULL DEFAULT 'WEB',
    "remembered" BOOLEAN NOT NULL DEFAULT false,
    "last_seen_at" TIMESTAMPTZ(3),

    CONSTRAINT "tenant_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_accounts_resident_id_key" ON "tenant_accounts"("resident_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_accounts_phone_key" ON "tenant_accounts"("phone");

-- CreateIndex
CREATE INDEX "tenant_accounts_property_id_idx" ON "tenant_accounts"("property_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_accounts_resident_id_property_id_key" ON "tenant_accounts"("resident_id", "property_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_invites_token_hash_key" ON "tenant_invites"("token_hash");

-- CreateIndex
CREATE INDEX "tenant_invites_account_id_idx" ON "tenant_invites"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_sessions_token_hash_key" ON "tenant_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "tenant_sessions_account_id_idx" ON "tenant_sessions"("account_id");

-- CreateIndex
CREATE INDEX "tenant_sessions_expires_at_idx" ON "tenant_sessions"("expires_at");

-- AddForeignKey
ALTER TABLE "tenant_accounts" ADD CONSTRAINT "tenant_accounts_resident_id_property_id_fkey" FOREIGN KEY ("resident_id", "property_id") REFERENCES "residents"("id", "property_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_invites" ADD CONSTRAINT "tenant_invites_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "tenant_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_sessions" ADD CONSTRAINT "tenant_sessions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "tenant_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Database-level guards mirroring the API rules.
ALTER TABLE "tenant_invites" ADD CONSTRAINT tenant_invite_channel CHECK (channel IN ('TELEGRAM','LINK'));
ALTER TABLE "tenant_sessions" ADD CONSTRAINT tenant_session_platform CHECK (platform IN ('WEB','ANDROID','IOS','WINDOWS'));
ALTER TABLE "tenant_accounts" ADD CONSTRAINT tenant_account_activation CHECK ((password_hash IS NULL) = (activated_at IS NULL));
