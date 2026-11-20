CREATE TABLE IF NOT EXISTS node_sessions (
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  password_stamp CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  mfa_verified TINYINT NOT NULL DEFAULT 0,
  expires_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX (user_id), INDEX (expires_at)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS node_mfa (
  user_id VARCHAR(36) PRIMARY KEY,
  secret_encrypted TEXT NOT NULL,
  last_counter BIGINT NOT NULL DEFAULT -1,
  enabled_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS node_mfa_recovery (
  user_id VARCHAR(36) NOT NULL,
  code_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (user_id, code_hash)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS node_challenges (
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  purpose VARCHAR(16) NOT NULL,
  password_stamp CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  session_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  secret_encrypted TEXT DEFAULT NULL,
  attempts INT NOT NULL DEFAULT 0,
  expires_at DATETIME NOT NULL,
  INDEX (user_id), INDEX (expires_at)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS node_rate_limits (
  bucket CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  window_start DATETIME NOT NULL,
  attempts INT NOT NULL,
  INDEX (window_start)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS node_schema_migrations (
  name VARCHAR(128) PRIMARY KEY,
  checksum CHAR(64) NOT NULL,
  applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;
