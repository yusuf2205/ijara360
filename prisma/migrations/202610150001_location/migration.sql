-- M7: resident geolocation (docs/M7-LOCATION.md). Current state + consent in one row per resident,
-- history as a separate time series. Plain PostgreSQL: no PostGIS at this scale.
INSERT INTO permissions(code) VALUES ('VIEW_LOCATION'),('VIEW_LOCATION_HISTORY');

CREATE TABLE "resident_locations" (
    "resident_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    -- Consent: the resident turns sharing on/off in the app; the primary device is one tenant session.
    "sharing_enabled" BOOLEAN NOT NULL DEFAULT false,
    "consented_at" TIMESTAMPTZ(3),
    "withdrawn_at" TIMESTAMPTZ(3),
    "primary_session_id" UUID,
    "device_label" VARCHAR(120),
    -- Last accepted position (newest recorded_at wins; older buffered points never replace it).
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "accuracy_m" REAL,
    "recorded_at" TIMESTAMPTZ(3),
    "received_at" TIMESTAMPTZ(3),
    -- Device telemetry, as reported by the app (the real OS state, never a UI toggle).
    "permission_state" VARCHAR(20) NOT NULL DEFAULT 'UNKNOWN',
    "services_enabled" BOOLEAN,
    "background_state" VARCHAR(20) NOT NULL DEFAULT 'UNKNOWN',
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" VARCHAR(20) NOT NULL DEFAULT 'OFFLINE',
    "status_reason" VARCHAR(40),
    "status_changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "resident_locations_pkey" PRIMARY KEY ("resident_id"),
    CONSTRAINT "resident_locations_resident_fkey" FOREIGN KEY ("resident_id","property_id") REFERENCES "residents"("id","property_id") ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT "resident_locations_session_fkey" FOREIGN KEY ("primary_session_id") REFERENCES "tenant_sessions"("id") ON DELETE SET NULL,
    CONSTRAINT "resident_location_status" CHECK ("status" IN ('LIVE','STALE','OFFLINE','LOCATION_DISABLED')),
    CONSTRAINT "resident_location_permission" CHECK ("permission_state" IN ('ALWAYS','WHILE_IN_USE','DENIED','UNKNOWN')),
    CONSTRAINT "resident_location_background" CHECK ("background_state" IN ('ALLOWED','RESTRICTED','UNKNOWN')),
    CONSTRAINT "resident_location_point" CHECK (("latitude" IS NULL) = ("longitude" IS NULL) AND ("latitude" IS NULL) = ("recorded_at" IS NULL)
        AND ("latitude" IS NULL OR ("latitude" BETWEEN -90 AND 90 AND "longitude" BETWEEN -180 AND 180 AND "accuracy_m" > 0)))
);
CREATE UNIQUE INDEX "resident_locations_resident_id_property_id_key" ON "resident_locations"("resident_id","property_id");
CREATE INDEX "resident_locations_property_id_idx" ON "resident_locations"("property_id");

CREATE TABLE "resident_location_points" (
    "id" BIGSERIAL NOT NULL,
    "resident_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    -- The tenant session (device) that sent it. No foreign key: history outlives the session.
    "session_id" UUID NOT NULL,
    "sequence" BIGINT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "accuracy_m" REAL NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "resident_location_points_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "resident_location_points_resident_fkey" FOREIGN KEY ("resident_id","property_id") REFERENCES "residents"("id","property_id") ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT "resident_location_points_range" CHECK ("latitude" BETWEEN -90 AND 90 AND "longitude" BETWEEN -180 AND 180 AND "accuracy_m" > 0 AND "sequence" >= 0)
);
-- Redelivery of the same event from the same device is a no-op.
CREATE UNIQUE INDEX "resident_location_points_session_sequence_key" ON "resident_location_points"("session_id","sequence");
CREATE INDEX "resident_location_points_resident_recorded_idx" ON "resident_location_points"("resident_id","recorded_at");
-- Retention deletes by age.
CREATE INDEX "resident_location_points_recorded_idx" ON "resident_location_points"("recorded_at");
