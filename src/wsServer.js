const { WebSocketServer } = require('ws');
const clientRegistry = require('./clientRegistry');
const callStore = require('./callStore');
const pushTokenStore = require('./pushTokenStore');
const pushSender = require('./pushSender');
const tokens = require('./tokens');
const T = require('./messageTypes');
const logger = require('./logger');

const RING_TIMEOUT_MS = Number(process.env.RING_TIMEOUT_MS || 30000);
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS || 15000);
const HEARTBEAT_TIMEOUT_MS = Number(process.env.HEARTBEAT_TIMEOUT_MS || 10000);

function send(ws, message) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function sendError(ws, callId, code, message) {
  send(ws, { type: T.ERROR, callId, code, message });
}

function attachWsServer(httpServer) {
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    let pongTimeout = null;

    const clearPongTimeout = () => {
      if (pongTimeout) {
        clearTimeout(pongTimeout);
        pongTimeout = null;
      }
    };

    ws.on('pong', () => {
      ws.isAlive = true;
      clearPongTimeout();
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        sendError(ws, undefined, 'bad-request', 'Message is not valid JSON');
        return;
      }
      handleMessage(ws, msg);
    });

    ws.on('close', () => {
      clearPongTimeout();
      handleDisconnect(ws);
    });

    // Exposed so the heartbeat interval below can start a bounded per-socket
    // timeout right after each ping, instead of only noticing a dead socket
    // on the NEXT interval tick (which doubles worst-case detection time —
    // a socket that dies right after being marked alive from a ping sent a
    // moment earlier won't be caught until the cycle after that).
    ws._sendHeartbeatPing = () => {
      ws.isAlive = false;
      ws.ping();
      clearPongTimeout();
      pongTimeout = setTimeout(() => {
        if (!ws.isAlive) {
          logger.warn('Heartbeat timeout, terminating socket for', ws.userId || '(unregistered)');
          ws.terminate();
        }
      }, HEARTBEAT_TIMEOUT_MS);
    };
  });

  // Heartbeat: ping every interval; each ping starts its own
  // HEARTBEAT_TIMEOUT_MS deadline (set up per-connection above), so a dead
  // socket is terminated within one interval + one timeout of actually
  // dying, not up to two full intervals.
  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      ws._sendHeartbeatPing?.();
    });
  }, HEARTBEAT_INTERVAL_MS);

  wss.on('close', () => clearInterval(heartbeat));

  return wss;
}

function handleMessage(ws, msg) {
  switch (msg.type) {
    case T.REGISTER:
      return onRegister(ws, msg);
    case T.REGISTER_PUSH_TOKEN:
      return onRegisterPushToken(ws, msg);
    case T.CALL_INVITE:
      return onCallInvite(ws, msg);
    case T.SDP_OFFER:
    case T.SDP_ANSWER:
    case T.ICE_CANDIDATE:
      return relay(ws, msg);
    case T.CALL_ACCEPT:
      return onCallAccept(ws, msg);
    case T.CALL_REJECT:
      return onCallTerminateByPeer(ws, msg, T.CALL_REJECT);
    case T.CALL_CANCEL:
      return onCallTerminateByPeer(ws, msg, T.CALL_CANCEL);
    case T.CALL_END:
      return onCallEnd(ws, msg);
    default:
      sendError(ws, msg.callId, 'bad-request', `Unknown message type: ${msg.type}`);
  }
}

// Identity now comes entirely from a server-issued accessToken (see
// routes/auth.js) instead of a client-claimed userId string — this is the
// "only registered users can call each other" enforcement point: there is no
// longer any way to speak on this socket as a user you didn't verify
// ownership of via email OTP.
function onRegister(ws, msg) {
  const { accessToken } = msg;
  if (!accessToken || typeof accessToken !== 'string') {
    sendError(ws, undefined, 'bad-request', 'register requires an accessToken');
    return;
  }

  let payload;
  try {
    payload = tokens.verifyAccessToken(accessToken);
  } catch (err) {
    logger.warn('Rejected register: invalid/expired accessToken -', err.message);
    send(ws, { type: T.REGISTERED, ok: false, reason: 'invalid-token' });
    return;
  }

  const userId = payload.username;
  if (clientRegistry.isRegistered(userId)) {
    send(ws, { type: T.REGISTERED, userId, ok: false, reason: 'id-in-use' });
    return;
  }
  clientRegistry.register(userId, ws);
  ws.userProfile = { id: payload.sub, email: payload.email, username: userId };
  logger.log('Registered', userId);
  send(ws, { type: T.REGISTERED, userId, ok: true });

  // A call-invite sent while this user was unreachable (app closed, woken
  // via FCM below) never reached them over a socket — redeliver it now that
  // they've reconnected, so the ringing UI actually surfaces instead of the
  // notification leading nowhere.
  const session = callStore.findActiveByUser(userId);
  if (session && session.state === 'ringing' && session.calleeId === userId) {
    send(ws, { type: T.CALL_INVITE, callId: session.callId, from: session.callerId });
  }
}

// Keyed off the socket's own authenticated identity (set by onRegister),
// never the message body — otherwise any registered client could plant a
// push token for someone else's username.
function onRegisterPushToken(ws, msg) {
  const { token } = msg;
  const userId = ws.userId;
  if (!userId) {
    sendError(ws, undefined, 'not-registered', 'register-push-token requires registering first');
    return;
  }
  if (!token) {
    sendError(ws, undefined, 'bad-request', 'register-push-token requires a token');
    return;
  }
  pushTokenStore.set(userId, token);
  logger.log('Stored push token for', userId);
}

async function onCallInvite(ws, msg) {
  const { callId, from, to } = msg;
  if (!callId || !from || !to) {
    sendError(ws, callId, 'bad-request', 'call-invite requires callId, from, to');
    return;
  }
  if (callStore.findActiveByUser(to)) {
    send(ws, { type: T.BUSY, callId, to });
    return;
  }

  const calleeWs = clientRegistry.get(to);
  if (calleeWs) {
    callStore.create(callId, from, to, (timedOutCallId) => onRingTimeoutFired(timedOutCallId), RING_TIMEOUT_MS);
    send(calleeWs, { type: T.CALL_INVITE, callId, from });
    send(ws, { type: T.CALL_RING, callId, to });
    return;
  }

  const delivered = await tryPushInvite(ws, callId, from, to);
  if (!delivered) sendError(ws, callId, 'callee-unavailable', `${to} is not online`);
}

// Callee has no live socket — wake them via FCM instead, if we have a token
// for them. Keeps the same call session/ring-timeout bookkeeping as the
// normal path, so a reconnect redelivers the invite (see onRegister above)
// and an unanswered push still times out the same way a normal ring would.
async function tryPushInvite(callerWs, callId, from, to) {
  const token = pushTokenStore.get(to);
  if (!token) return false;

  const sent = await pushSender.sendCallInvitePush(token, { callId, from, to });
  if (!sent) return false;

  callStore.create(callId, from, to, (timedOutCallId) => onRingTimeoutFired(timedOutCallId), RING_TIMEOUT_MS);
  send(callerWs, { type: T.CALL_RING, callId, to });
  logger.log('Sent FCM call-invite push to', to, 'for', callId);
  return true;
}

function onRingTimeoutFired(callId) {
  const session = callStore.get(callId);
  if (!session || session.state !== 'ringing') return;
  const callerWs = clientRegistry.get(session.callerId);
  const calleeWs = clientRegistry.get(session.calleeId);
  send(callerWs, { type: T.TIMEOUT, callId, code: 'no-answer' });
  send(calleeWs, { type: T.TIMEOUT, callId, code: 'no-answer' });
  callStore.remove(callId);
  logger.log('Call timed out (no answer):', callId);
}

function relay(ws, msg) {
  const { callId, to } = msg;
  if (!to) {
    sendError(ws, callId, 'bad-request', 'Message requires a to field');
    return;
  }
  const targetWs = clientRegistry.get(to);
  if (!targetWs) {
    sendError(ws, callId, 'callee-unavailable', `${to} is not online`);
    return;
  }
  send(targetWs, msg);
}

function onCallAccept(ws, msg) {
  const { callId } = msg;
  const session = callStore.get(callId);
  if (!session) {
    sendError(ws, callId, 'unknown-call', `No such call: ${callId}`);
    return;
  }
  callStore.markConnected(callId);
  relay(ws, msg);
  logger.log('Call connected:', callId);
}

function onCallTerminateByPeer(ws, msg, type) {
  const { callId } = msg;
  const session = callStore.get(callId);
  if (!session) {
    sendError(ws, callId, 'unknown-call', `No such call: ${callId}`);
    return;
  }
  callStore.remove(callId);
  relay(ws, { ...msg, type });
}

function onCallEnd(ws, msg) {
  const { callId } = msg;
  const session = callStore.get(callId);
  if (session) callStore.remove(callId);
  relay(ws, msg);
  logger.log('Call ended:', callId);
}

function handleDisconnect(ws) {
  const userId = ws.userId;
  if (!userId) return;
  clientRegistry.unregister(userId);
  logger.log('Disconnected:', userId);

  const session = callStore.findActiveByUser(userId);
  if (!session) return;

  const otherUserId = session.callerId === userId ? session.calleeId : session.callerId;
  const otherWs = clientRegistry.get(otherUserId);
  callStore.remove(session.callId);
  send(otherWs, {
    type: T.CALL_END,
    callId: session.callId,
    from: userId,
    to: otherUserId,
    reason: 'network-drop',
  });
  logger.log('Synthesized network-drop call-end for', session.callId);
}

module.exports = { attachWsServer };
