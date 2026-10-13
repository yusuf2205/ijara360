-- M5: in-app notifications for tenants and staff, and a Telegram outbox written in the same
-- transaction as the event, delivered after commit with retries.
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "tenant_account_id" UUID,
    "user_id" UUID,
    "kind" VARCHAR(40) NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "body" VARCHAR(1000) NOT NULL,
    "link" VARCHAR(300),
    "entity" VARCHAR(40),
    "entity_id" UUID,
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "notification_recipient" CHECK (("tenant_account_id" IS NULL) <> ("user_id" IS NULL)),
    CONSTRAINT "notification_link" CHECK ("link" IS NULL OR "link" LIKE '/%')
);
CREATE TABLE "notification_deliveries" (
    "id" UUID NOT NULL,
    "notification_id" UUID NOT NULL,
    "channel" VARCHAR(20) NOT NULL DEFAULT 'TELEGRAM',
    "chat_id" VARCHAR(30) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMPTZ(3),
    "sent_at" TIMESTAMPTZ(3),
    "last_error" VARCHAR(40),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "delivery_channel" CHECK ("channel" IN ('TELEGRAM')),
    CONSTRAINT "delivery_status" CHECK ("status" IN ('PENDING','SENDING','SENT','FAILED'))
);
CREATE INDEX "notifications_tenant_account_id_created_at_idx" ON "notifications"("tenant_account_id", "created_at");
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications"("user_id", "created_at");
CREATE INDEX "notifications_unread_tenant_idx" ON "notifications"("tenant_account_id") WHERE "read_at" IS NULL;
CREATE INDEX "notifications_unread_user_idx" ON "notifications"("user_id") WHERE "read_at" IS NULL;
CREATE INDEX "notification_deliveries_due_idx" ON "notification_deliveries"("next_attempt_at") WHERE "status" = 'PENDING';
CREATE INDEX "notification_deliveries_notification_id_idx" ON "notification_deliveries"("notification_id");
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_account_id_fkey" FOREIGN KEY ("tenant_account_id") REFERENCES "tenant_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
