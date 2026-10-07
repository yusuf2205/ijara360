-- Archived rooms leave the numbering: only active rooms must have unique numbers,
-- so the active list can always be renumbered 1, 2, 3… after a room is removed.
DROP INDEX "rooms_property_id_number_key";
CREATE UNIQUE INDEX "rooms_property_id_number_active_key" ON "rooms"("property_id", "number") WHERE "archived_at" IS NULL;
