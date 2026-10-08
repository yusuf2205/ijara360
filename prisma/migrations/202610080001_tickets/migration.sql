-- M5: tenant tickets (complaints, suggestions, repairs). Authors are visible only to OWNER/SUPER_ADMIN;
-- the API anonymises tickets for everyone else.
INSERT INTO permissions(code) VALUES ('TICKETS_VIEW'),('TICKETS_MANAGE');

CREATE TABLE "tickets" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "resident_id" UUID NOT NULL,
    "room_id" UUID,
    "category" VARCHAR(20) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'OPEN',
    "title" VARCHAR(120) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(3),
    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ticket_category" CHECK ("category" IN ('COMPLAINT','SUGGESTION','REPAIR')),
    CONSTRAINT "ticket_status" CHECK ("status" IN ('OPEN','IN_PROGRESS','RESOLVED','REJECTED')),
    CONSTRAINT "ticket_closed" CHECK (("closed_at" IS NULL) = ("status" IN ('OPEN','IN_PROGRESS'))),
    CONSTRAINT "ticket_title" CHECK (length(btrim("title")) > 0)
);

CREATE TABLE "ticket_messages" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "author_type" VARCHAR(10) NOT NULL,
    "staff_user_id" UUID,
    "body" VARCHAR(4000) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_messages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ticket_message_author" CHECK (("author_type" = 'TENANT' AND "staff_user_id" IS NULL) OR ("author_type" = 'STAFF' AND "staff_user_id" IS NOT NULL)),
    CONSTRAINT "ticket_message_body" CHECK (length(btrim("body")) > 0)
);

CREATE INDEX "tickets_property_id_status_created_at_idx" ON "tickets"("property_id", "status", "created_at");
CREATE INDEX "tickets_resident_id_created_at_idx" ON "tickets"("resident_id", "created_at");
CREATE INDEX "ticket_messages_ticket_id_created_at_idx" ON "ticket_messages"("ticket_id", "created_at");

ALTER TABLE "tickets" ADD CONSTRAINT "tickets_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_resident_id_property_id_fkey" FOREIGN KEY ("resident_id", "property_id") REFERENCES "residents"("id", "property_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_room_id_property_id_fkey" FOREIGN KEY ("room_id", "property_id") REFERENCES "rooms"("id", "property_id") ON DELETE SET NULL ("room_id") ON UPDATE RESTRICT;
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_staff_user_id_fkey" FOREIGN KEY ("staff_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
