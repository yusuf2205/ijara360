-- Planned end of a stay (end-of-stay reminders). Kept apart from occupancies: those rows may only ever be
-- closed (preserve_occupancy_history) and are part of the deploy data fingerprint, while a plan is extended
-- or removed. Each change is in audit_logs (OCCUPANCY_PLAN_SET). reminder_stage is the last reminder sent:
-- 1 two weeks left, 2 three days, 3 the last day, 4 overdue.
CREATE TABLE "occupancy_plans" (
    "occupancy_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "planned_end_date" DATE NOT NULL,
    "reminder_stage" SMALLINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "occupancy_plans_pkey" PRIMARY KEY ("occupancy_id"),
    CONSTRAINT "occupancy_plans_reminder_stage" CHECK ("reminder_stage" BETWEEN 0 AND 4)
);
CREATE INDEX "occupancy_plans_property_id_planned_end_date_idx" ON "occupancy_plans"("property_id", "planned_end_date");
ALTER TABLE "occupancy_plans" ADD CONSTRAINT "occupancy_plans_occupancy_id_fkey" FOREIGN KEY ("occupancy_id") REFERENCES "occupancies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "occupancy_plans" ADD CONSTRAINT "occupancy_plans_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
