-- M5: remembered devices and session list.
ALTER TABLE "sessions" ADD COLUMN "device_name" VARCHAR(120);
ALTER TABLE "sessions" ADD COLUMN "platform" VARCHAR(20) NOT NULL DEFAULT 'WEB';
ALTER TABLE "sessions" ADD COLUMN "remembered" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "sessions" ADD COLUMN "last_seen_at" TIMESTAMP(3);
ALTER TABLE "sessions" ADD CONSTRAINT session_platform CHECK (platform IN ('WEB','ANDROID','IOS','WINDOWS'));
