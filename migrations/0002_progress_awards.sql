ALTER TABLE user_progress ADD COLUMN beaten INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_progress ADD COLUMN mastered INTEGER NOT NULL DEFAULT 0;

UPDATE user_progress SET fetched_at = 0;
