-- Automatic monthly rent charges: a per-property switch, off by default so an installation that is still
-- being set up bills nothing until the owner turns it on in Settings.
ALTER TABLE "properties" ADD COLUMN "auto_billing_enabled" BOOLEAN NOT NULL DEFAULT false;
