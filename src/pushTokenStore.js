// Map<userId, FCM token>. Kept separate from clientRegistry (live sockets)
// because a token must survive a disconnect — it's only useful for exactly
// the moment the user is NOT connected.
const tokens = new Map();

function set(userId, token) {
  tokens.set(userId, token);
}

function get(userId) {
  return tokens.get(userId);
}

module.exports = { set, get };
