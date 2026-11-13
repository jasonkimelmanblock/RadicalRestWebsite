CREATE TABLE registration_checkouts (
  id uuid PRIMARY KEY,
  retreat text NOT NULL,
  accommodation text NOT NULL,
  occupancy integer NOT NULL CHECK (occupancy IN (1, 2)),
  details jsonb NOT NULL,
  stripe_session_id text UNIQUE,
  registration_id integer UNIQUE REFERENCES registrations(id),
  hold_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX registration_checkouts_holds ON registration_checkouts (retreat, accommodation, hold_until) WHERE registration_id IS NULL;
