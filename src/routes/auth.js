const express = require('express');
const db = require('../db');
const tokens = require('../tokens');
const { generateOtp, hashOtp, OTP_TTL_MS, OTP_MAX_ATTEMPTS } = require('../otp');
const { sendOtpEmail } = require('../email');
const logger = require('../logger');

const USERNAME_RE = /^[a-z0-9_]{3,20}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const router = express.Router();

// Wraps an async route handler so a rejected promise reaches Express's error
// middleware instead of crashing the process (Express doesn't do this itself
// pre-v5).
const ah = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.get(
  '/check-username',
  ah(async (req, res) => {
    const username = String(req.query.username || '').trim();
    if (!USERNAME_RE.test(username)) {
      return res.json({ available: false, reason: 'invalid' });
    }
    const { rows } = await db.query('SELECT 1 FROM users WHERE lower(username) = lower($1)', [username]);
    res.json({ available: rows.length === 0 });
  }),
);

router.post(
  '/signup',
  ah(async (req, res) => {
    const { email, username, fullName } = req.body || {};
    if (!EMAIL_RE.test(email || '')) return res.status(400).json({ error: 'invalid-email' });
    if (!USERNAME_RE.test(username || '')) return res.status(400).json({ error: 'invalid-username' });
    if (!fullName || !String(fullName).trim()) return res.status(400).json({ error: 'invalid-full-name' });

    const normalizedEmail = email.trim().toLowerCase();

    const emailTaken = await db.query('SELECT 1 FROM users WHERE email = $1', [normalizedEmail]);
    if (emailTaken.rows.length > 0) {
      return res
        .status(409)
        .json({ error: 'email-registered', message: 'This email is already registered — log in instead.' });
    }
    const usernameTaken = await db.query('SELECT 1 FROM users WHERE lower(username) = lower($1)', [username]);
    if (usernameTaken.rows.length > 0) {
      return res.status(409).json({ error: 'username-taken' });
    }

    const code = generateOtp();
    await db.query(
      `INSERT INTO otp_codes (email, purpose, code_hash, expires_at, pending_username, pending_full_name)
       VALUES ($1, 'signup', $2, $3, $4, $5)`,
      [normalizedEmail, hashOtp(code, normalizedEmail), new Date(Date.now() + OTP_TTL_MS), username, fullName.trim()],
    );
    await sendOtpEmail(normalizedEmail, code, 'signup');
    res.json({ ok: true });
  }),
);

router.post(
  '/login',
  ah(async (req, res) => {
    const { email } = req.body || {};
    if (!EMAIL_RE.test(email || '')) return res.status(400).json({ error: 'invalid-email' });
    const normalizedEmail = email.trim().toLowerCase();

    const { rows } = await db.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'no-account', message: 'No account with that email — sign up instead.' });
    }

    const code = generateOtp();
    await db.query(
      `INSERT INTO otp_codes (email, purpose, code_hash, expires_at) VALUES ($1, 'login', $2, $3)`,
      [normalizedEmail, hashOtp(code, normalizedEmail), new Date(Date.now() + OTP_TTL_MS)],
    );
    await sendOtpEmail(normalizedEmail, code, 'login');
    res.json({ ok: true });
  }),
);

router.post(
  '/verify-otp',
  ah(async (req, res) => {
    const { email, code, purpose } = req.body || {};
    if (!EMAIL_RE.test(email || '') || !code || (purpose !== 'signup' && purpose !== 'login')) {
      return res.status(400).json({ error: 'bad-request' });
    }
    const normalizedEmail = email.trim().toLowerCase();

    const { rows } = await db.query(
      `SELECT * FROM otp_codes WHERE email = $1 AND purpose = $2 AND consumed_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [normalizedEmail, purpose],
    );
    const otpRow = rows[0];
    if (!otpRow) return res.status(400).json({ error: 'no-pending-otp' });
    if (new Date(otpRow.expires_at) < new Date()) return res.status(400).json({ error: 'otp-expired' });
    if (otpRow.attempts >= OTP_MAX_ATTEMPTS) return res.status(429).json({ error: 'too-many-attempts' });

    if (otpRow.code_hash !== hashOtp(String(code).trim(), normalizedEmail)) {
      await db.query('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1', [otpRow.id]);
      return res.status(400).json({ error: 'wrong-code' });
    }

    await db.query('UPDATE otp_codes SET consumed_at = now() WHERE id = $1', [otpRow.id]);

    let user;
    if (purpose === 'signup') {
      try {
        const inserted = await db.query(
          `INSERT INTO users (email, username, full_name, email_verified_at)
           VALUES ($1, $2, $3, now()) RETURNING id, email, username, full_name`,
          [normalizedEmail, otpRow.pending_username, otpRow.pending_full_name],
        );
        user = inserted.rows[0];
      } catch (err) {
        if (err.code === '23505') {
          // Someone else claimed the same username/email between signup and
          // this verify call — ask the client to pick another, rather than
          // silently failing.
          return res.status(409).json({ error: 'username-taken', message: 'That username was just taken — pick another.' });
        }
        throw err;
      }
    } else {
      const found = await db.query('SELECT id, email, username, full_name FROM users WHERE email = $1', [
        normalizedEmail,
      ]);
      user = found.rows[0];
      if (!user) return res.status(404).json({ error: 'no-account' });
    }

    const session = await issueSession(user);
    logger.log(`${purpose === 'signup' ? 'Signed up' : 'Logged in'}:`, user.username);
    res.json({ ok: true, user: toUserJson(user), ...session });
  }),
);

router.post(
  '/refresh',
  ah(async (req, res) => {
    const { refreshToken } = req.body || {};
    if (!refreshToken) return res.status(400).json({ error: 'bad-request' });

    const hash = tokens.hashRefreshToken(refreshToken);
    const { rows } = await db.query(
      `SELECT rt.id, rt.expires_at, u.id AS user_id, u.email, u.username, u.full_name
       FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = $1 AND rt.revoked_at IS NULL`,
      [hash],
    );
    const row = rows[0];
    if (!row || new Date(row.expires_at) < new Date()) {
      return res.status(401).json({ error: 'invalid-refresh-token' });
    }

    await db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1', [row.id]);
    const user = { id: row.user_id, email: row.email, username: row.username, full_name: row.full_name };
    const session = await issueSession(user);
    res.json({ ok: true, user: toUserJson(user), ...session });
  }),
);

router.post(
  '/logout',
  ah(async (req, res) => {
    const { refreshToken } = req.body || {};
    if (refreshToken) {
      await db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1', [
        tokens.hashRefreshToken(refreshToken),
      ]);
    }
    res.json({ ok: true });
  }),
);

// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  logger.warn('Auth API error:', err.message);
  res.status(500).json({ error: 'internal-error' });
});

async function issueSession(user) {
  const accessToken = tokens.signAccessToken(user);
  const refresh = tokens.generateRefreshToken();
  await db.query('INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)', [
    user.id,
    refresh.hash,
    refresh.expiresAt,
  ]);
  return { accessToken, refreshToken: refresh.token };
}

function toUserJson(user) {
  return { id: user.id, email: user.email, username: user.username, fullName: user.full_name };
}

module.exports = router;
