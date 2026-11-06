// Map<callId, CallSession> of in-progress call attempts/connections.
// CallSession = { callId, callerId, calleeId, state: 'ringing'|'connected', ringTimeout }
const calls = new Map();

function create(callId, callerId, calleeId, onRingTimeout, ringTimeoutMs) {
  const session = {
    callId,
    callerId,
    calleeId,
    state: 'ringing',
    createdAt: Date.now(),
    ringTimeout: setTimeout(() => onRingTimeout(callId), ringTimeoutMs),
  };
  calls.set(callId, session);
  return session;
}

function get(callId) {
  return calls.get(callId);
}

function markConnected(callId) {
  const session = calls.get(callId);
  if (!session) return;
  clearTimeout(session.ringTimeout);
  session.state = 'connected';
}

function remove(callId) {
  const session = calls.get(callId);
  if (session) clearTimeout(session.ringTimeout);
  calls.delete(callId);
}

// Any active call session (ringing or connected) involving this userId, as caller or callee.
function findActiveByUser(userId) {
  for (const session of calls.values()) {
    if (session.callerId === userId || session.calleeId === userId) {
      return session;
    }
  }
  return undefined;
}

module.exports = { create, get, markConnected, remove, findActiveByUser };
