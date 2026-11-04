-- 1. Abandoned applications (owner's decision, 2026-11-05): a draft or an application waiting for the
--    applicant's changes (NEEDS_INFO) is cancelled and emptied after 30 days without changes. Same rules as
--    kyc_purge_closed_application: only this function removes the data, and it re-checks the period itself.
CREATE FUNCTION kyc_expire_stale_application(application_uuid uuid, empty_profile text) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public AS $$
DECLARE
  target public.rental_applications;
  removed integer;
BEGIN
  SELECT * INTO target FROM public.rental_applications WHERE id = application_uuid AND status IN ('DRAFT','NEEDS_INFO')
    AND profile_purged_at IS NULL AND updated_at <= CURRENT_TIMESTAMP - INTERVAL '30 days' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'application % is not abandoned', application_uuid; END IF;
  INSERT INTO public.application_status_history (id, application_id, from_status, to_status, actor_id)
    VALUES (gen_random_uuid(), application_uuid, target.status, 'CANCELLED', NULL);
  DELETE FROM public.applicant_sessions WHERE application_id = application_uuid;
  DELETE FROM public.phone_challenges WHERE application_id = application_uuid;
  DELETE FROM public.biometric_enrollment_sources WHERE application_id = application_uuid;
  DELETE FROM public.application_documents WHERE application_id = application_uuid;
  GET DIAGNOSTICS removed = ROW_COUNT;
  UPDATE public.rental_applications SET status = 'CANCELLED', version = version + 1, profile_cipher = empty_profile, phone_hash = repeat('0', 64),
    pinfl_hash = NULL, passport_hash = NULL, tenant_password_hash = NULL, feedback_cipher = NULL, duplicate_review_cipher = NULL,
    documents_purged_at = CURRENT_TIMESTAMP, profile_purged_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = application_uuid;
  RETURN removed;
END $$;
REVOKE ALL ON FUNCTION kyc_expire_stale_application(uuid, text) FROM PUBLIC;

-- 2. Where the house is, for "at home / not at home" on the staff home screen. Unset until the owner sets it.
--    (The deploy data fingerprint projects only the original properties columns.)
ALTER TABLE "properties" ADD COLUMN "home_latitude" DOUBLE PRECISION, ADD COLUMN "home_longitude" DOUBLE PRECISION,
  ADD COLUMN "home_radius_m" INTEGER NOT NULL DEFAULT 150;
ALTER TABLE "properties" ADD CONSTRAINT "property_home_point" CHECK ((home_latitude IS NULL) = (home_longitude IS NULL)
  AND (home_latitude IS NULL OR (home_latitude BETWEEN -90 AND 90 AND home_longitude BETWEEN -180 AND 180)));
ALTER TABLE "properties" ADD CONSTRAINT "property_home_radius" CHECK (home_radius_m BETWEEN 25 AND 2000);

-- 3. The resident's app language, so notifications (and their Telegram copies) arrive in it.
ALTER TABLE "tenant_accounts" ADD COLUMN "lang" VARCHAR(2) NOT NULL DEFAULT 'ru';
ALTER TABLE "tenant_accounts" ADD CONSTRAINT "tenant_account_lang" CHECK (lang IN ('ru','uz'));
