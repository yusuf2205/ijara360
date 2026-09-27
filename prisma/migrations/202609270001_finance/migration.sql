-- CreateEnum
CREATE TYPE "charge_status" AS ENUM ('UNPAID', 'PARTIALLY_PAID', 'PAID', 'OVERDUE');

-- CreateEnum
CREATE TYPE "charge_type" AS ENUM ('RENT', 'DEPOSIT', 'PENALTY', 'UTILITIES', 'OTHER');

-- CreateEnum
CREATE TYPE "payment_method" AS ENUM ('CASH', 'CARD_TRANSFER', 'BANK_TRANSFER', 'OTHER');

-- AlterTable
ALTER TABLE "residents" ADD COLUMN     "access_granted" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "access_status_reason" VARCHAR(255) NOT NULL DEFAULT 'OK',
ADD COLUMN     "finance_checked_at" TIMESTAMPTZ(3),
ADD COLUMN     "total_debt" DECIMAL(18,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "charges" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "resident_id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "bed_id" UUID NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "paid_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "due_amount" DECIMAL(10,2) GENERATED ALWAYS AS (amount - paid_amount) STORED NOT NULL,
    "type" "charge_type" NOT NULL DEFAULT 'RENT',
    "status" "charge_status" NOT NULL DEFAULT 'UNPAID',
    "billing_period_start" DATE NOT NULL,
    "billing_period_end" DATE NOT NULL,
    "due_date" DATE NOT NULL,
    "grace_period_days" INTEGER NOT NULL DEFAULT 0,
    "idempotency_key" UUID NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "charges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "charge_id" UUID NOT NULL,
    "resident_id" UUID NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "method" "payment_method" NOT NULL DEFAULT 'CASH',
    "comment" VARCHAR(2000),
    "created_by_user_id" UUID NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "charges_property_id_due_date_idx" ON "charges"("property_id", "due_date");

-- CreateIndex
CREATE INDEX "charges_resident_id_created_at_idx" ON "charges"("resident_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "charges_id_resident_id_property_id_key" ON "charges"("id", "resident_id", "property_id");

-- CreateIndex
CREATE UNIQUE INDEX "charges_property_id_idempotency_key_key" ON "charges"("property_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "payments_charge_id_idx" ON "payments"("charge_id");

-- CreateIndex
CREATE INDEX "payments_resident_id_created_at_idx" ON "payments"("resident_id", "created_at");

-- CreateIndex
CREATE INDEX "payments_property_id_created_at_idx" ON "payments"("property_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payments_property_id_idempotency_key_key" ON "payments"("property_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "charges" ADD CONSTRAINT "charges_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charges" ADD CONSTRAINT "charges_resident_id_property_id_fkey" FOREIGN KEY ("resident_id", "property_id") REFERENCES "residents"("id", "property_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "charges" ADD CONSTRAINT "charges_room_id_property_id_fkey" FOREIGN KEY ("room_id", "property_id") REFERENCES "rooms"("id", "property_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "charges" ADD CONSTRAINT "charges_bed_id_room_id_fkey" FOREIGN KEY ("bed_id", "room_id") REFERENCES "beds"("id", "room_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "charges" ADD CONSTRAINT "charges_created_by_user_id_property_id_fkey" FOREIGN KEY ("created_by_user_id", "property_id") REFERENCES "users"("id", "property_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_charge_id_resident_id_property_id_fkey" FOREIGN KEY ("charge_id", "resident_id", "property_id") REFERENCES "charges"("id", "resident_id", "property_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_resident_id_property_id_fkey" FOREIGN KEY ("resident_id", "property_id") REFERENCES "residents"("id", "property_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_created_by_user_id_property_id_fkey" FOREIGN KEY ("created_by_user_id", "property_id") REFERENCES "users"("id", "property_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Money is decimal throughout. Ledger entries cannot be silently edited/deleted.
ALTER TABLE charges ADD CONSTRAINT charges_money CHECK (amount > 0 AND paid_amount >= 0 AND paid_amount <= amount),
  ADD CONSTRAINT charges_dates CHECK (billing_period_end >= billing_period_start AND billing_period_start >= DATE '1900-01-01' AND billing_period_end <= DATE '9999-12-31' AND due_date BETWEEN DATE '1900-01-01' AND DATE '9999-12-31'),
  ADD CONSTRAINT charges_grace CHECK (grace_period_days BETWEEN 0 AND 365);
ALTER TABLE payments ADD CONSTRAINT payments_positive CHECK (amount > 0);
ALTER TABLE residents ADD CONSTRAINT resident_debt_nonnegative CHECK (total_debt >= 0);

CREATE FUNCTION finance_today() RETURNS date LANGUAGE sql STABLE
  SET search_path = pg_catalog, public AS $$ SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Tashkent')::date $$;

CREATE FUNCTION finance_charge_status(amount numeric, paid numeric, due date) RETURNS charge_status LANGUAGE sql STABLE
  SET search_path = pg_catalog, public AS $$
  SELECT (CASE WHEN paid = amount THEN 'PAID' WHEN due < public.finance_today() THEN 'OVERDUE'
    WHEN paid > 0 THEN 'PARTIALLY_PAID' ELSE 'UNPAID' END)::public.charge_status
$$;

CREATE FUNCTION finance_refresh_resident(resident_uuid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public AS $$
DECLARE debt numeric; blocked boolean; in_grace boolean;
BEGIN
  SELECT coalesce(sum(due_amount),0), coalesce(bool_or(due_amount > 0 AND due_date + grace_period_days < public.finance_today()),false),
    coalesce(bool_or(due_amount > 0 AND due_date < public.finance_today()),false)
    INTO debt, blocked, in_grace FROM public.charges WHERE resident_id = resident_uuid;
  UPDATE public.residents SET total_debt = debt, access_granted = NOT blocked,
    access_status_reason = CASE WHEN blocked THEN 'OVERDUE' WHEN in_grace THEN 'GRACE_PERIOD' ELSE 'OK' END,
    finance_checked_at = CURRENT_TIMESTAMP WHERE id = resident_uuid;
END $$;

CREATE FUNCTION finance_guard_charge() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Financial history cannot be deleted'; END IF;
  PERFORM id FROM public.properties WHERE id = NEW.property_id FOR UPDATE;
  IF TG_OP = 'UPDATE' AND
    (to_jsonb(NEW) - ARRAY['paid_amount','due_amount','status','updated_at']) IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['paid_amount','due_amount','status','updated_at']) THEN
    RAISE EXCEPTION 'Charge terms are immutable';
  END IF;
  IF NEW.paid_amount <> (SELECT coalesce(sum(amount),0) FROM public.payments WHERE charge_id = NEW.id) THEN
    RAISE EXCEPTION 'Paid amount must match payment ledger';
  END IF;
  NEW.status := public.finance_charge_status(NEW.amount, NEW.paid_amount, NEW.due_date);
  RETURN NEW;
END $$;
CREATE TRIGGER finance_guard_charge BEFORE INSERT OR UPDATE OR DELETE ON charges FOR EACH ROW EXECUTE FUNCTION finance_guard_charge();

CREATE FUNCTION finance_charge_inserted() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.finance_refresh_resident(NEW.resident_id);
  RETURN NEW;
END $$;
CREATE TRIGGER finance_charge_inserted AFTER INSERT ON charges FOR EACH ROW EXECUTE FUNCTION finance_charge_inserted();

CREATE FUNCTION finance_guard_payment() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public AS $$
DECLARE remaining numeric;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Payment ledger is append only'; END IF;
  PERFORM id FROM public.properties WHERE id = NEW.property_id FOR UPDATE;
  SELECT due_amount INTO remaining FROM public.charges WHERE id = NEW.charge_id AND resident_id = NEW.resident_id AND property_id = NEW.property_id FOR UPDATE;
  IF remaining IS NULL OR NEW.amount > remaining THEN RAISE EXCEPTION 'Payment exceeds outstanding charge or charge not found'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER finance_guard_payment BEFORE INSERT OR UPDATE OR DELETE ON payments FOR EACH ROW EXECUTE FUNCTION finance_guard_payment();

CREATE FUNCTION finance_payment_inserted() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.charges SET paid_amount = (SELECT coalesce(sum(amount),0) FROM public.payments WHERE charge_id = NEW.charge_id), updated_at = CURRENT_TIMESTAMP WHERE id = NEW.charge_id;
  PERFORM public.finance_refresh_resident(NEW.resident_id);
  RETURN NEW;
END $$;
CREATE TRIGGER finance_payment_inserted AFTER INSERT ON payments FOR EACH ROW EXECUTE FUNCTION finance_payment_inserted();

-- Serializes with every M2/M3 write. Catch-up on startup, every minute, and before finance reads.
CREATE FUNCTION finance_refresh_property(property_uuid uuid) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public AS $$
DECLARE item record; refreshed integer := 0;
BEGIN
  PERFORM id FROM public.properties WHERE id = property_uuid FOR UPDATE;
  UPDATE public.charges SET status = public.finance_charge_status(amount,paid_amount,due_date), updated_at = CURRENT_TIMESTAMP
    WHERE property_id = property_uuid AND status IS DISTINCT FROM public.finance_charge_status(amount,paid_amount,due_date);
  FOR item IN SELECT id FROM public.residents WHERE property_id = property_uuid LOOP
    PERFORM public.finance_refresh_resident(item.id);
    refreshed := refreshed + 1;
  END LOOP;
  RETURN refreshed;
END $$;

REVOKE ALL ON FUNCTION finance_refresh_resident(uuid), finance_refresh_property(uuid), finance_charge_inserted(), finance_payment_inserted(), finance_guard_payment() FROM PUBLIC;
