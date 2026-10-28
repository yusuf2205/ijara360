-- Payment reminders: a per-property switch, on by default. Residents who use the app are reminded about
-- rent due soon or overdue, at most once a day each. (This column is already outside the deploy data
-- fingerprint, which projects only the original properties columns.)
ALTER TABLE "properties" ADD COLUMN "payment_reminders_enabled" BOOLEAN NOT NULL DEFAULT true;
