-- AlterTable
ALTER TABLE "payments" ALTER COLUMN "charge_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "residents" ADD COLUMN     "credit_balance" DECIMAL(18,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "payment_allocations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "property_id" UUID NOT NULL,
    "resident_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "charge_id" UUID NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_allocations_charge_id_idx" ON "payment_allocations"("charge_id");

-- CreateIndex
CREATE INDEX "payment_allocations_property_id_resident_id_idx" ON "payment_allocations"("property_id", "resident_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_allocations_payment_id_charge_id_key" ON "payment_allocations"("payment_id", "charge_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_id_resident_id_property_id_key" ON "payments"("id", "resident_id", "property_id");

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_id_resident_id_property_id_fkey" FOREIGN KEY ("payment_id", "resident_id", "property_id") REFERENCES "payments"("id", "resident_id", "property_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_charge_id_resident_id_property_id_fkey" FOREIGN KEY ("charge_id", "resident_id", "property_id") REFERENCES "charges"("id", "resident_id", "property_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE residents ADD CONSTRAINT resident_credit_nonnegative CHECK (credit_balance >= 0);
ALTER TABLE payment_allocations ADD CONSTRAINT allocation_positive CHECK (amount > 0);

-- Preserve already recorded direct payments as receipts + allocations, without duplicating cash.
INSERT INTO payment_allocations(property_id,resident_id,payment_id,charge_id,amount,created_at)
  SELECT property_id,resident_id,id,charge_id,amount,created_at FROM payments WHERE charge_id IS NOT NULL;

CREATE OR REPLACE FUNCTION finance_refresh_resident(resident_uuid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public AS $$
DECLARE debt numeric; credit numeric; blocked boolean; in_grace boolean;
BEGIN
  SELECT coalesce(sum(due_amount),0), coalesce(bool_or(due_amount > 0 AND due_date + grace_period_days < public.finance_today()),false),
    coalesce(bool_or(due_amount > 0 AND due_date < public.finance_today()),false)
    INTO debt, blocked, in_grace FROM public.charges WHERE resident_id = resident_uuid;
  SELECT (SELECT coalesce(sum(amount),0) FROM public.payments WHERE resident_id=resident_uuid)
    - (SELECT coalesce(sum(amount),0) FROM public.payment_allocations WHERE resident_id=resident_uuid) INTO credit;
  UPDATE public.residents SET total_debt=debt, credit_balance=credit, access_granted=NOT blocked,
    access_status_reason=CASE WHEN blocked THEN 'OVERDUE' WHEN in_grace THEN 'GRACE_PERIOD' ELSE 'OK' END,
    finance_checked_at=CURRENT_TIMESTAMP WHERE id=resident_uuid;
END $$;

CREATE OR REPLACE FUNCTION finance_guard_charge() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Financial history cannot be deleted'; END IF;
  PERFORM id FROM public.properties WHERE id=NEW.property_id FOR UPDATE;
  IF TG_OP='UPDATE' AND
    (to_jsonb(NEW)-ARRAY['paid_amount','due_amount','status','updated_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['paid_amount','due_amount','status','updated_at']) THEN RAISE EXCEPTION 'Charge terms are immutable'; END IF;
  IF NEW.paid_amount<>(SELECT coalesce(sum(amount),0) FROM public.payment_allocations WHERE charge_id=NEW.id) THEN RAISE EXCEPTION 'Paid amount must match allocations'; END IF;
  NEW.status:=public.finance_charge_status(NEW.amount,NEW.paid_amount,NEW.due_date);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION finance_guard_payment() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Payment ledger is append only'; END IF;
  PERFORM id FROM public.properties WHERE id=NEW.property_id FOR UPDATE;
  -- Excess cash is retained as credit, never forced into a charge beyond its amount.
  RETURN NEW;
END $$;

CREATE FUNCTION finance_guard_allocation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public AS $$
DECLARE charge_remaining numeric; payment_remaining numeric;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Allocation history is append only'; END IF;
  PERFORM id FROM public.properties WHERE id=NEW.property_id FOR UPDATE;
  SELECT due_amount INTO charge_remaining FROM public.charges WHERE id=NEW.charge_id AND resident_id=NEW.resident_id AND property_id=NEW.property_id FOR UPDATE;
  SELECT amount-(SELECT coalesce(sum(amount),0) FROM public.payment_allocations WHERE payment_id=NEW.payment_id)
    INTO payment_remaining FROM public.payments WHERE id=NEW.payment_id AND resident_id=NEW.resident_id AND property_id=NEW.property_id FOR UPDATE;
  IF charge_remaining IS NULL OR payment_remaining IS NULL OR NEW.amount>charge_remaining OR NEW.amount>payment_remaining THEN
    RAISE EXCEPTION 'Allocation exceeds charge or receipt balance or crosses scope';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER finance_guard_allocation BEFORE INSERT OR UPDATE OR DELETE ON payment_allocations FOR EACH ROW EXECUTE FUNCTION finance_guard_allocation();

CREATE FUNCTION finance_allocation_inserted() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.charges SET paid_amount=(SELECT coalesce(sum(amount),0) FROM public.payment_allocations WHERE charge_id=NEW.charge_id),updated_at=CURRENT_TIMESTAMP WHERE id=NEW.charge_id;
  PERFORM public.finance_refresh_resident(NEW.resident_id);
  RETURN NEW;
END $$;
CREATE TRIGGER finance_allocation_inserted AFTER INSERT ON payment_allocations FOR EACH ROW EXECUTE FUNCTION finance_allocation_inserted();

CREATE FUNCTION finance_allocate_credit(resident_uuid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public AS $$
DECLARE charge_row record; receipt record; remainder numeric; part numeric; property_uuid uuid;
BEGIN
  SELECT property_id INTO property_uuid FROM public.residents WHERE id=resident_uuid;
  PERFORM id FROM public.properties WHERE id=property_uuid FOR UPDATE;
  FOR charge_row IN SELECT * FROM public.charges WHERE resident_id=resident_uuid AND due_amount>0
    ORDER BY due_date,created_at,id FOR UPDATE LOOP
    remainder:=charge_row.due_amount;
    FOR receipt IN SELECT p.*,p.amount-(SELECT coalesce(sum(a.amount),0) FROM public.payment_allocations a WHERE a.payment_id=p.id) AS available
      FROM public.payments p WHERE p.resident_id=resident_uuid ORDER BY p.created_at,p.id LOOP
      IF receipt.available<=0 THEN CONTINUE; END IF;
      part:=least(remainder,receipt.available);
      INSERT INTO public.payment_allocations(property_id,resident_id,payment_id,charge_id,amount)
        VALUES(property_uuid,resident_uuid,receipt.id,charge_row.id,part);
      remainder:=remainder-part;
      IF remainder=0 THEN EXIT; END IF;
    END LOOP;
  END LOOP;
  PERFORM public.finance_refresh_resident(resident_uuid);
END $$;

CREATE OR REPLACE FUNCTION finance_charge_inserted() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.finance_allocate_credit(NEW.resident_id);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION finance_payment_inserted() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.finance_allocate_credit(NEW.resident_id);
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION finance_guard_allocation(),finance_allocation_inserted(),finance_allocate_credit(uuid) FROM PUBLIC;
-- Catch up projections after backfill without altering the original M2 data.
DO $$ DECLARE item record; BEGIN FOR item IN SELECT id FROM properties LOOP PERFORM finance_refresh_property(item.id); END LOOP; END $$;
