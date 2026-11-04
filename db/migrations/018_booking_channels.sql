-- OB-SRC-01: where an online booking came from (Яндекс Карты, 2ГИС, Instagram, сайт…).
-- The widget link carries ?src=<channel>; the visit keeps it, a new client keeps the first one.
ALTER TABLE appointments ADD COLUMN channel text CHECK (channel ~ '^[a-z0-9_-]{1,24}$');
ALTER TABLE clients ADD COLUMN channel text CHECK (channel ~ '^[a-z0-9_-]{1,24}$');
CREATE INDEX appointments_channel ON appointments (branch_id, channel) WHERE channel IS NOT NULL;
