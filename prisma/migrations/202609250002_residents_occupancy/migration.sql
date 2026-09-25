-- CreateEnum
CREATE TYPE "OccupancyStatus" AS ENUM ('ACTIVE', 'CLOSED');

-- CreateTable
CREATE TABLE "residents" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "full_name" VARCHAR(160) NOT NULL,
    "phone" VARCHAR(16) NOT NULL,
    "photo_url" VARCHAR(500),
    "note" VARCHAR(2000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "residents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "occupancies" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "resident_id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "bed_id" UUID NOT NULL,
    "move_in_date" DATE NOT NULL,
    "move_out_date" DATE,
    "monthly_price" DECIMAL(14,2) NOT NULL,
    "payment_day" INTEGER NOT NULL,
    "deposit_amount" DECIMAL(14,2) NOT NULL,
    "status" "OccupancyStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "occupancies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "residents_property_id_phone_key" ON "residents"("property_id", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "residents_id_property_id_key" ON "residents"("id", "property_id");

-- CreateIndex
CREATE INDEX "occupancies_property_id_status_idx" ON "occupancies"("property_id", "status");

-- CreateIndex
CREATE INDEX "occupancies_resident_id_move_in_date_idx" ON "occupancies"("resident_id", "move_in_date");

-- CreateIndex
CREATE INDEX "occupancies_bed_id_move_in_date_idx" ON "occupancies"("bed_id", "move_in_date");

-- CreateIndex
CREATE UNIQUE INDEX "users_id_property_id_key" ON "users"("id", "property_id");

-- CreateIndex
CREATE UNIQUE INDEX "rooms_id_property_id_key" ON "rooms"("id", "property_id");

-- CreateIndex
CREATE UNIQUE INDEX "beds_id_room_id_key" ON "beds"("id", "room_id");

-- AddForeignKey
ALTER TABLE "residents" ADD CONSTRAINT "residents_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "occupancies" ADD CONSTRAINT "occupancies_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "occupancies" ADD CONSTRAINT "occupancies_resident_id_property_id_fkey" FOREIGN KEY ("resident_id", "property_id") REFERENCES "residents"("id", "property_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "occupancies" ADD CONSTRAINT "occupancies_room_id_property_id_fkey" FOREIGN KEY ("room_id", "property_id") REFERENCES "rooms"("id", "property_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "occupancies" ADD CONSTRAINT "occupancies_bed_id_room_id_fkey" FOREIGN KEY ("bed_id", "room_id") REFERENCES "beds"("id", "room_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "occupancies" ADD CONSTRAINT "occupancies_created_by_property_id_fkey" FOREIGN KEY ("created_by", "property_id") REFERENCES "users"("id", "property_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- M2 invariants. These partial indexes are maintained in migrations, not db push.
CREATE UNIQUE INDEX occupancy_active_bed ON occupancies(bed_id) WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX occupancy_active_resident ON occupancies(resident_id) WHERE status = 'ACTIVE';
ALTER TABLE residents ADD CONSTRAINT resident_phone CHECK (phone ~ '^\+[1-9][0-9]{7,14}$');
ALTER TABLE residents ADD CONSTRAINT resident_name CHECK (length(btrim(full_name)) > 0);
ALTER TABLE occupancies ADD CONSTRAINT occupancy_state CHECK (
  (status = 'ACTIVE' AND move_out_date IS NULL) OR
  (status = 'CLOSED' AND move_out_date IS NOT NULL AND move_out_date >= move_in_date)
);
ALTER TABLE occupancies ADD CONSTRAINT occupancy_money CHECK (monthly_price >= 0 AND deposit_amount >= 0);
ALTER TABLE occupancies ADD CONSTRAINT occupancy_payment_day CHECK (payment_day BETWEEN 1 AND 31);
CREATE FUNCTION preserve_occupancy_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Occupancy history cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'CLOSED' OR NEW.status <> 'CLOSED' OR
     ROW(NEW.id, NEW.property_id, NEW.resident_id, NEW.room_id, NEW.bed_id, NEW.move_in_date,
         NEW.monthly_price, NEW.payment_day, NEW.deposit_amount, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.property_id, OLD.resident_id, OLD.room_id, OLD.bed_id, OLD.move_in_date,
         OLD.monthly_price, OLD.payment_day, OLD.deposit_amount, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'Only closing active occupancy is allowed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER occupancy_history BEFORE UPDATE OR DELETE ON occupancies FOR EACH ROW EXECUTE FUNCTION preserve_occupancy_history();
