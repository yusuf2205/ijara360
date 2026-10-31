-- Owner's decision, 2026-10-31: passports, selfies, PINFL and passport numbers are kept 2 years after check-out;
-- rejected and cancelled applications are kept 1 week.
-- The periods live here so that a bug in the API cannot remove data early: the runtime role still has no
-- DELETE on these tables and can only call the functions below. Encryption stays in the API, which passes
-- in the re-encrypted profile.
-- (rental_applications is outside the deploy data fingerprint, so the new columns do not change it.)
ALTER TABLE "rental_applications" ADD COLUMN "documents_purged_at" TIMESTAMPTZ(3);
ALTER TABLE "rental_applications" ADD COLUMN "profile_purged_at" TIMESTAMPTZ(3);

CREATE FUNCTION kyc_documents_expired(resident_uuid uuid) RETURNS boolean LANGUAGE sql STABLE
  SET search_path = pg_catalog, public AS $$
  SELECT NOT EXISTS (SELECT 1 FROM public.occupancies WHERE resident_id = resident_uuid AND status = 'ACTIVE')
    AND COALESCE((SELECT max(move_out_date) FROM public.occupancies WHERE resident_id = resident_uuid AND status = 'CLOSED')
      <= (CURRENT_DATE - INTERVAL '2 years')::date, false);
$$;

CREATE FUNCTION kyc_purge_application_documents(application_uuid uuid, cleaned_profile text) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public AS $$
DECLARE
  target public.rental_applications;
  removed integer;
BEGIN
  SELECT * INTO target FROM public.rental_applications
    WHERE id = application_uuid AND status = 'CONVERTED_TO_RESIDENT' AND documents_purged_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'application % has no documents to purge', application_uuid; END IF;
  -- Held until commit: a returning resident's check-in waits, then the period is judged on committed data.
  PERFORM id FROM public.residents WHERE id = target.resident_id FOR UPDATE;
  IF NOT public.kyc_documents_expired(target.resident_id) THEN
    RAISE EXCEPTION 'retention period of application % has not ended', application_uuid;
  END IF;
  DELETE FROM public.biometric_enrollment_sources WHERE application_id = application_uuid;
  DELETE FROM public.application_documents WHERE application_id = application_uuid;
  GET DIAGNOSTICS removed = ROW_COUNT;
  UPDATE public.rental_applications SET profile_cipher = cleaned_profile, pinfl_hash = NULL, passport_hash = NULL,
    documents_purged_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = application_uuid;
  RETURN removed;
END $$;

-- Keeps only the row, its dates and status history: no personal data and nothing to match a person by.
CREATE FUNCTION kyc_purge_closed_application(application_uuid uuid, empty_profile text) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public AS $$
DECLARE
  removed integer;
BEGIN
  PERFORM id FROM public.rental_applications WHERE id = application_uuid AND status IN ('REJECTED','CANCELLED')
    AND profile_purged_at IS NULL AND updated_at <= CURRENT_TIMESTAMP - INTERVAL '7 days' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'retention period of application % has not ended', application_uuid; END IF;
  DELETE FROM public.applicant_sessions WHERE application_id = application_uuid;
  DELETE FROM public.phone_challenges WHERE application_id = application_uuid;
  DELETE FROM public.biometric_enrollment_sources WHERE application_id = application_uuid;
  DELETE FROM public.application_documents WHERE application_id = application_uuid;
  GET DIAGNOSTICS removed = ROW_COUNT;
  UPDATE public.rental_applications SET profile_cipher = empty_profile, phone_hash = repeat('0', 64), pinfl_hash = NULL, passport_hash = NULL,
    tenant_password_hash = NULL, feedback_cipher = NULL, duplicate_review_cipher = NULL,
    documents_purged_at = CURRENT_TIMESTAMP, profile_purged_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = application_uuid;
  RETURN removed;
END $$;

REVOKE ALL ON FUNCTION kyc_documents_expired(uuid), kyc_purge_application_documents(uuid, text), kyc_purge_closed_application(uuid, text) FROM PUBLIC;
