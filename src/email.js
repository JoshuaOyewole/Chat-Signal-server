// Sends OTP codes via Resend. With no RESEND_API_KEY configured, this logs
// the code to the console instead of throwing — lets the whole signup/login
// flow be built and tested before a real account exists (same pattern as
// pushSender.js's optional Firebase config).
const logger = require('./logger');

let resendClient = null;
let initAttempted = false;

function getResend() {
  if (initAttempted) return resendClient;
  initAttempted = true;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    logger.log('RESEND_API_KEY not set — OTP codes will be logged to the console instead of emailed.');
    return null;
  }
  const { Resend } = require('resend');
  resendClient = new Resend(apiKey);
  return resendClient;
}

async function sendOtpEmail(email, code, purpose) {
  const subject = purpose === 'signup' ? 'Verify your Townhall Hub email' : 'Your Townhall Hub login code';
  const text = `Your code is ${code}. It expires in 10 minutes.`;

  const resend = getResend();
  if (!resend) {
    logger.log(`[dev-mode email] to=${email} subject="${subject}" code=${code}`);
    return;
  }

  const { error } = await resend.emails.send({
    from: process.env.RESEND_FROM_EMAIL || 'Townhall Hub <onboarding@resend.dev>',
    to: email,
    subject,
    text,
  });
  if (error) {
    logger.warn('Resend send failed:', error.message || error);
    throw new Error('Failed to send email');
  }
}

module.exports = { sendOtpEmail };
