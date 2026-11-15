// Sends the FCM data message that wakes a callee's device when they can't
// be reached over an open WebSocket. Lazily initialized and entirely
// optional: with no FIREBASE_SERVICE_ACCOUNT_PATH/_JSON configured, every
// call here just resolves false instead of throwing, so the rest of the
// server (and offline calls simply failing with "callee-unavailable") keeps
// working unchanged before a Firebase project exists.
const logger = require('./logger');

let messaging = null;
let initAttempted = false;

function getMessaging() {
  if (initAttempted) return messaging;
  initAttempted = true;
  try {
    const path = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
    const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!path && !json) {
      logger.log('Push notifications disabled: set FIREBASE_SERVICE_ACCOUNT_PATH or _JSON to enable');
      return null;
    }
    const admin = require('firebase-admin');
    const credential = json
      ? admin.credential.cert(JSON.parse(json))
      : admin.credential.cert(require(require('path').resolve(path)));
    admin.initializeApp({ credential });
    messaging = admin.messaging();
    logger.log('Push notifications enabled');
  } catch (err) {
    logger.warn('Push notifications disabled:', err.message);
    messaging = null;
  }
  return messaging;
}

async function sendCallInvitePush(token, { callId, from, to }) {
  const m = getMessaging();
  if (!m) return false;
  try {
    await m.send({
      token,
      android: { priority: 'high' },
      data: { type: 'call-invite', callId, from, to },
    });
    return true;
  } catch (err) {
    logger.warn('FCM send failed for', to, '-', err.message);
    return false;
  }
}

module.exports = { sendCallInvitePush };
