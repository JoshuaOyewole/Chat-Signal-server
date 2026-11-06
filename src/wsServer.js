const { WebSocketServer } = require('ws');
const clientRegistry = require('./clientRegistry');
const callStore = require('./callStore');
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
    ws.on('pong', () => {
      ws.isAlive = true;
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
      handleDisconnect(ws);
    });
  });

  // Heartbeat: ping every interval; terminate sockets that didn't pong in time.
  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) {
        logger.warn('Heartbeat timeout, terminating socket for', ws.userId || '(unregistered)');
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, HEARTBEAT_INTERVAL_MS);
  // Give each ping HEARTBEAT_TIMEOUT_MS to be answered before the next cycle marks it dead.
  void HEARTBEAT_TIMEOUT_MS;

  wss.on('close', () => clearInterval(heartbeat));

  return wss;
}

function handleMessage(ws, msg) {
  switch (msg.type) {
    case T.REGISTER:
      return onRegister(ws, msg);
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

function onRegister(ws, msg) {
  const { userId } = msg;
  if (!userId || typeof userId !== 'string') {
    sendError(ws, undefined, 'bad-request', 'register requires a userId string');
    return;
  }
  if (clientRegistry.isRegistered(userId)) {
    send(ws, { type: T.REGISTERED, userId, ok: false, reason: 'id-in-use' });
    return;
  }
  clientRegistry.register(userId, ws);
  logger.log('Registered', userId);
  send(ws, { type: T.REGISTERED, userId, ok: true });
}

function onCallInvite(ws, msg) {
  const { callId, from, to } = msg;
  if (!callId || !from || !to) {
    sendError(ws, callId, 'bad-request', 'call-invite requires callId, from, to');
    return;
  }
  const calleeWs = clientRegistry.get(to);
  if (!calleeWs) {
    sendError(ws, callId, 'callee-unavailable', `${to} is not online`);
    return;
  }
  if (callStore.findActiveByUser(to)) {
    send(ws, { type: T.BUSY, callId, to });
    return;
  }

  callStore.create(callId, from, to, (timedOutCallId) => onRingTimeoutFired(timedOutCallId), RING_TIMEOUT_MS);

  send(calleeWs, { type: T.CALL_INVITE, callId, from });
  send(ws, { type: T.CALL_RING, callId, to });
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
