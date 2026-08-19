CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  system TEXT NOT NULL,
  box_art TEXT NOT NULL,
  total_achievements INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_profiles (
  username TEXT PRIMARY KEY,
  display_username TEXT NOT NULL,
  avatar TEXT NOT NULL,
  motto TEXT NOT NULL,
  total_points INTEGER NOT NULL,
  true_points INTEGER NOT NULL,
  member_since TEXT NOT NULL,
  rich_presence TEXT NOT NULL,
  missing INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_progress (
  username TEXT NOT NULL,
  game_id INTEGER NOT NULL,
  num_possible_achievements INTEGER NOT NULL,
  possible_score INTEGER NOT NULL,
  num_achieved INTEGER NOT NULL,
  score_achieved INTEGER NOT NULL,
  num_achieved_hardcore INTEGER NOT NULL,
  score_achieved_hardcore INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (username, game_id)
);

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
