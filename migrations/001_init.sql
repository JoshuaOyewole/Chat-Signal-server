CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  email_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per OTP sent. A signup OTP carries the pending account details,
-- which only become a `users` row once that code is verified — so an
-- abandoned signup never permanently squats a username or email.
CREATE TABLE IF NOT EXISTS otp_codes (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('signup', 'login')),
  code_hash TEXT NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  pending_username TEXT,
  pending_full_name TEXT
);

CREATE INDEX IF NOT EXISTS idx_otp_codes_email_purpose ON otp_codes (email, purpose, created_at DESC);

-- Refresh tokens are stored hashed (never the raw token) and rotated on every
-- use, so a stolen row from a DB leak can't itself be replayed as a token.
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens (user_id);
