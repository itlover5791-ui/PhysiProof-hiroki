-- Preserve user IDs and foreign keys while allowing accounts without a password.
ALTER TABLE users ADD COLUMN legacy_hash_copy TEXT;
UPDATE users SET legacy_hash_copy = password_hash;
ALTER TABLE users DROP COLUMN password_hash;
ALTER TABLE users RENAME COLUMN legacy_hash_copy TO password_hash;

CREATE TABLE auth_identities (
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (issuer, subject),
  UNIQUE (user_id, issuer)
);

CREATE TABLE google_auth_requests (
  state TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  link_user TEXT REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE google_auth_pending (
  ticket_hash TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  link_user TEXT REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
