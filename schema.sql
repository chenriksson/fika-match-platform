CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  group_size INTEGER NOT NULL CHECK (group_size BETWEEN 2 AND 4),
  reset_threshold_percent NUMERIC NOT NULL CHECK (reset_threshold_percent BETWEEN 0 AND 100)
);

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  opted_out BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS rounds (
  id BIGSERIAL PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  generation_key TEXT NOT NULL,
  reset_performed BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (group_id, generation_key)
);

CREATE TABLE IF NOT EXISTS matches (
  id BIGSERIAL PRIMARY KEY,
  round_id BIGINT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS match_participants (
  match_id BIGINT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  PRIMARY KEY (match_id, member_id)
);

CREATE TABLE IF NOT EXISTS pair_history (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  left_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  right_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (group_id, left_member_id, right_member_id),
  CHECK (left_member_id < right_member_id)
);

CREATE TABLE IF NOT EXISTS notification_outbox (
  id BIGSERIAL PRIMARY KEY,
  round_id BIGINT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  recipient_emails TEXT[] NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_until TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (round_id, recipient_emails)
);

CREATE INDEX IF NOT EXISTS notification_outbox_ready_idx
  ON notification_outbox (available_at)
  WHERE status IN ('pending', 'processing');

CREATE TABLE IF NOT EXISTS app_theme (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  logo_text TEXT NOT NULL,
  brand_name TEXT NOT NULL,
  page_title TEXT NOT NULL,
  tagline TEXT NOT NULL,
  primary_color TEXT NOT NULL,
  secondary_color TEXT NOT NULL,
  accent_color TEXT NOT NULL,
  paper_color TEXT NOT NULL,
  ink_color TEXT NOT NULL,
  color_mode TEXT NOT NULL DEFAULT 'light' CHECK (color_mode IN ('light', 'dark')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE app_theme ADD COLUMN IF NOT EXISTS color_mode TEXT NOT NULL DEFAULT 'light';
DO $$
BEGIN
  ALTER TABLE app_theme ADD CONSTRAINT app_theme_color_mode_check CHECK (color_mode IN ('light', 'dark'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

INSERT INTO app_theme (id, logo_text, brand_name, page_title, tagline, primary_color, secondary_color, accent_color, paper_color, ink_color, color_mode)
VALUES (1, 'f', 'Fika', 'Make room for a good conversation.', 'Community matching', '#ef725f', '#6caaa1', '#e0ad55', '#f5f1e8', '#26302d', 'light')
ON CONFLICT (id) DO NOTHING;

INSERT INTO groups (id, name, group_size, reset_threshold_percent)
VALUES ('demo', 'Fika Berlin', 2, 15)
ON CONFLICT (id) DO NOTHING;

INSERT INTO members (id, group_id, email, name)
VALUES
  ('jordan', 'demo', 'jordan@example.com', 'Jordan Davis'),
  ('maya', 'demo', 'maya@example.com', 'Maya Chen'),
  ('theo', 'demo', 'theo@example.com', 'Theo Martin'),
  ('priya', 'demo', 'priya@example.com', 'Priya Shah'),
  ('sam', 'demo', 'sam@example.com', 'Sam Okafor'),
  ('leo', 'demo', 'leo@example.com', 'Leo Fischer')
ON CONFLICT (id) DO NOTHING;
