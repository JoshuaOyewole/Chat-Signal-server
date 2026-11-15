const crypto = require('crypto');

const OTP_LENGTH = 6;
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;

function generateOtp() {
  const n = crypto.randomInt(0, 10 ** OTP_LENGTH);
  return String(n).padStart(OTP_LENGTH, '0');
}

// Binds the hash to the email so a leaked hash can't be replayed against a
// different account, and salts with a server secret so the hash alone isn't
// a 6-digit-space brute-force target.
function hashOtp(code, email) {
  const secret = process.env.OTP_HASH_SECRET || 'dev-insecure-otp-secret';
  return crypto.createHash('sha256').update(`${secret}:${email}:${code}`).digest('hex');
}

module.exports = { generateOtp, hashOtp, OTP_LENGTH, OTP_TTL_MS, OTP_MAX_ATTEMPTS };
