ALTER TABLE rooms ADD COLUMN archived_at TIMESTAMPTZ(3);

-- Lock the same room for archive and occupancy insertion, including direct SQL.
CREATE FUNCTION guard_room_archive() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.archived_at IS NOT NULL AND EXISTS (
    SELECT 1 FROM occupancies WHERE room_id = NEW.id AND status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Occupied room cannot be archived' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER room_archive BEFORE UPDATE ON rooms FOR EACH ROW EXECUTE FUNCTION guard_room_archive();

CREATE FUNCTION guard_archived_occupancy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE archived TIMESTAMPTZ;
BEGIN
  SELECT archived_at INTO archived FROM rooms WHERE id = NEW.room_id FOR UPDATE;
  IF archived IS NOT NULL THEN
    RAISE EXCEPTION 'Archived room cannot accept occupancy' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER occupancy_room_active BEFORE INSERT ON occupancies FOR EACH ROW EXECUTE FUNCTION guard_archived_occupancy();

-- Existing RESTRICT foreign keys protect all occupancy and finance history on deletion.
