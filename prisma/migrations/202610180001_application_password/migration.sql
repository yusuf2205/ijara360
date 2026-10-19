-- The applicant sets their own password at the end of the application; the login is their phone number.
-- Stored as an Argon2 hash only; on conversion the tenant account is created active with it.
ALTER TABLE "rental_applications" ADD COLUMN "tenant_password_hash" TEXT;
