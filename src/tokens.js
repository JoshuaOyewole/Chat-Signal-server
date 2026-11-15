const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// The access token itself is long-lived (30 days, per product requirement) —
// unusual for a JWT, but the refresh token's only job here is letting that
// 30-day token renew silently instead of forcing a re-login when it expires.
const ACCESS_TOKEN_TTL = '30d';
const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function requireSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is not set — see README\'s "Account setup" section.');
  }
  return secret;
}

function signAccessToken(user) {
  return jwt.sign({ sub: user.id, username: user.username, email: user.email }, requireSecret(), {
    expiresIn: ACCESS_TOKEN_TTL,
  });
}

// Throws (jwt.JsonWebTokenError / TokenExpiredError) on anything invalid —
// callers decide how to respond, this never returns a half-valid payload.
function verifyAccessToken(token) {
  return jwt.verify(token, requireSecret());
}

function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateRefreshToken() {
  const token = crypto.randomBytes(32).toString('hex');
  return { token, hash: hashRefreshToken(token), expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS) };
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  ACCESS_TOKEN_TTL,
  REFRESH_TOKEN_TTL_MS,
};
