// Map<userId, WebSocket> of currently connected, registered clients.
// Each registered socket also gets `ws.userId` set for reverse lookup on close.
const clients = new Map();

function register(userId, ws) {
  clients.set(userId, ws);
  ws.userId = userId;
}

function unregister(userId) {
  clients.delete(userId);
}

function get(userId) {
  return clients.get(userId);
}

function isRegistered(userId) {
  return clients.has(userId);
}

module.exports = { register, unregister, get, isRegistered };
