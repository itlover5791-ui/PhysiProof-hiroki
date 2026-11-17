ALTER TABLE uniform_assets ADD COLUMN reward_only INTEGER NOT NULL DEFAULT 0 CHECK (reward_only IN (0, 1));
ALTER TABLE map_chest_claims ADD COLUMN reward_json TEXT;

CREATE TABLE chest_reward_catalog (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('emblem', 'pattern', 'title', 'buff')),
  tier TEXT NOT NULL CHECK (tier IN ('small', 'medium', 'large')),
  builtin_code TEXT,
  asset_id TEXT REFERENCES uniform_assets(id),
  asset_revision INTEGER,
  boost_percent INTEGER,
  duration_minutes INTEGER,
  revision INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  FOREIGN KEY (asset_id, asset_revision) REFERENCES uniform_asset_versions(asset_id, revision)
);
CREATE INDEX idx_chest_reward_draw ON chest_reward_catalog (tier, kind) WHERE archived=0;
CREATE INDEX idx_chest_reward_claim_asset ON map_chest_claims (
  user_id, json_extract(reward_json, '$.asset.id'), json_extract(reward_json, '$.asset.revision')
) WHERE reward_json IS NOT NULL;

INSERT INTO chest_reward_catalog (id, name, kind, tier, builtin_code) VALUES
  ('chest-sprout', 'トレイルスプラウト', 'emblem', 'small', 'chest-sprout'),
  ('chest-ripple', 'リップルライン', 'pattern', 'small', 'chest-ripple'),
  ('chest-compass', 'ノースコンパス', 'emblem', 'medium', 'chest-compass'),
  ('chest-switchback', 'スイッチバック', 'pattern', 'medium', 'chest-switchback'),
  ('chest-crown', 'サミットクラウン', 'emblem', 'large', 'chest-crown'),
  ('chest-aurora', 'オーロラリボン', 'pattern', 'large', 'chest-aurora');

UPDATE map_chest_claims SET reward_json = (
  SELECT json_object('id', id, 'name', name, 'kind', kind, 'tier', tier, 'builtin_code', builtin_code,
    'asset', NULL, 'buff', NULL, 'revision', revision)
  FROM chest_reward_catalog WHERE id=map_chest_claims.reward_id
) WHERE reward_id IS NOT NULL;

CREATE TABLE chest_equipped_titles (
  user_id TEXT PRIMARY KEY NOT NULL,
  reward_id TEXT NOT NULL,
  FOREIGN KEY (user_id, reward_id) REFERENCES map_chest_claims(user_id, reward_id) ON DELETE CASCADE
);
