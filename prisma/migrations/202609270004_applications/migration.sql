-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'NEEDS_INFO', 'APPROVED', 'REJECTED', 'CANCELLED', 'CONVERTED_TO_RESIDENT');

-- CreateEnum
CREATE TYPE "ApplicationChannel" AS ENUM ('WEB', 'TELEGRAM');

-- CreateEnum
CREATE TYPE "DocumentKind" AS ENUM ('PASSPORT_FRONT', 'PASSPORT_BACK', 'FACE');

-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'SUPER_ADMIN';

-- AlterTable
ALTER TABLE "audit_logs" ALTER COLUMN "actor_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "permissions" (
    "code" VARCHAR(80) NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "user_permissions" (
    "user_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "permission_code" VARCHAR(80) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_permissions_pkey" PRIMARY KEY ("user_id","permission_code")
);

-- CreateTable
CREATE TABLE "rental_applications" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'DRAFT',
    "channel" "ApplicationChannel" NOT NULL DEFAULT 'WEB',
    "version" INTEGER NOT NULL DEFAULT 1,
    "profile_cipher" TEXT NOT NULL,
    "phone_hash" CHAR(64) NOT NULL,
    "pinfl_hash" CHAR(64),
    "passport_hash" CHAR(64),
    "phone_verified_at" TIMESTAMPTZ(3),
    "phone_verification_method" VARCHAR(40),
    "resident_id" UUID,
    "occupancy_id" UUID,
    "feedback_cipher" TEXT,
    "duplicate_review_cipher" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submitted_at" TIMESTAMPTZ(3),
    "approved_at" TIMESTAMPTZ(3),
    "rejected_at" TIMESTAMPTZ(3),
    "converted_at" TIMESTAMPTZ(3),
    "archived_at" TIMESTAMPTZ(3),
    "retention_policy" TEXT NOT NULL DEFAULT 'MANUAL_REVIEW',

    CONSTRAINT "rental_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "applicant_sessions" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "applicant_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "phone_challenges" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "telegram_user_id" VARCHAR(30),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),

    CONSTRAINT "phone_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_documents" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "kind" "DocumentKind" NOT NULL,
    "storage_key" VARCHAR(200) NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "mime_type" VARCHAR(40) NOT NULL,
    "size" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "application_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "biometric_enrollment_sources" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'BIOMETRIC_ENROLLMENT_SOURCE',
    "quality_review" TEXT NOT NULL DEFAULT 'MANUAL_REQUIRED',

    CONSTRAINT "biometric_enrollment_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_status_history" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "from_status" "ApplicationStatus",
    "to_status" "ApplicationStatus" NOT NULL,
    "actor_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "application_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rental_applications_occupancy_id_key" ON "rental_applications"("occupancy_id");

-- CreateIndex
CREATE INDEX "rental_applications_property_id_status_created_at_idx" ON "rental_applications"("property_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "rental_applications_property_id_phone_hash_idx" ON "rental_applications"("property_id", "phone_hash");

-- CreateIndex
CREATE INDEX "rental_applications_property_id_pinfl_hash_idx" ON "rental_applications"("property_id", "pinfl_hash");

-- CreateIndex
CREATE INDEX "rental_applications_property_id_passport_hash_idx" ON "rental_applications"("property_id", "passport_hash");

-- CreateIndex
CREATE UNIQUE INDEX "rental_applications_id_property_id_key" ON "rental_applications"("id", "property_id");

-- CreateIndex
CREATE UNIQUE INDEX "applicant_sessions_token_hash_key" ON "applicant_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "applicant_sessions_expires_at_idx" ON "applicant_sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "phone_challenges_token_hash_key" ON "phone_challenges"("token_hash");

-- CreateIndex
CREATE INDEX "phone_challenges_telegram_user_id_expires_at_idx" ON "phone_challenges"("telegram_user_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "application_documents_application_id_kind_key" ON "application_documents"("application_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "biometric_enrollment_sources_application_id_key" ON "biometric_enrollment_sources"("application_id");

-- CreateIndex
CREATE UNIQUE INDEX "biometric_enrollment_sources_document_id_key" ON "biometric_enrollment_sources"("document_id");

-- CreateIndex
CREATE INDEX "application_status_history_application_id_created_at_idx" ON "application_status_history"("application_id", "created_at");

-- AddForeignKey
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_user_id_property_id_fkey" FOREIGN KEY ("user_id", "property_id") REFERENCES "users"("id", "property_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_permission_code_fkey" FOREIGN KEY ("permission_code") REFERENCES "permissions"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_applications" ADD CONSTRAINT "rental_applications_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_applications" ADD CONSTRAINT "rental_applications_resident_id_property_id_fkey" FOREIGN KEY ("resident_id", "property_id") REFERENCES "residents"("id", "property_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "applicant_sessions" ADD CONSTRAINT "applicant_sessions_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "rental_applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phone_challenges" ADD CONSTRAINT "phone_challenges_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "rental_applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_documents" ADD CONSTRAINT "application_documents_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "rental_applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biometric_enrollment_sources" ADD CONSTRAINT "biometric_enrollment_sources_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "rental_applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biometric_enrollment_sources" ADD CONSTRAINT "biometric_enrollment_sources_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "application_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_status_history" ADD CONSTRAINT "application_status_history_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "rental_applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO permissions(code) VALUES
('APPLICATION_VIEW'),('APPLICATION_REVIEW'),('APPLICATION_APPROVE'),('APPLICATION_REJECT'),
('KYC_VIEW_BASIC'),('KYC_VIEW_DOCUMENTS'),('KYC_VIEW_PASSPORT'),('KYC_VIEW_BIOMETRIC_SOURCE'),('RESIDENT_CREATE_FROM_APPLICATION');
CREATE TRIGGER application_history_immutable BEFORE UPDATE OR DELETE ON application_status_history FOR EACH ROW EXECUTE FUNCTION reject_audit_change();
ALTER TABLE rental_applications ADD CONSTRAINT application_version_positive CHECK(version > 0);
ALTER TABLE rental_applications ADD CONSTRAINT application_conversion CHECK((status='CONVERTED_TO_RESIDENT') = (resident_id IS NOT NULL AND occupancy_id IS NOT NULL));
CREATE FUNCTION guard_application_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    OLD.status IN ('DRAFT','NEEDS_INFO') AND NEW.status IN ('SUBMITTED','CANCELLED') OR
    OLD.status='SUBMITTED' AND NEW.status IN ('UNDER_REVIEW','CANCELLED') OR
    OLD.status='UNDER_REVIEW' AND NEW.status IN ('NEEDS_INFO','APPROVED','REJECTED','CANCELLED') OR
    OLD.status='APPROVED' AND NEW.status='CONVERTED_TO_RESIDENT'
  ) THEN RAISE EXCEPTION 'Invalid application transition' USING ERRCODE='23514'; END IF;
  IF NEW.status NOT IN ('DRAFT','CANCELLED') AND NEW.phone_verified_at IS NULL THEN
    RAISE EXCEPTION 'Phone verification required' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER application_transition BEFORE UPDATE ON rental_applications FOR EACH ROW EXECUTE FUNCTION guard_application_transition();

CREATE TABLE telegram_cursors(id TEXT PRIMARY KEY,last_update_id INTEGER NOT NULL DEFAULT 0);
