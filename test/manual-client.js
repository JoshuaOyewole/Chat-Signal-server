// Minimal CLI WebSocket client for exercising the signaling server without the RN app.
// Usage:
//   node test/manual-client.js <serverUrl> <userId>
// Then type JSON-ish shorthand commands at the prompt:
//   call <calleeId>        -> sends call-invite (with a fake SDP offer)
//   accept <callId> <peer> -> sends call-accept + a fake SDP answer
//   reject <callId> <peer>
//   cancel <callId> <peer>
//   end <callId> <peer>
// Useful for the "busy" test scenario: run a third client, call a user who is
// already mid-call with someone else, and confirm you receive a `busy` message.
const WebSocket = require('ws');
const readline = require('readline');

const [, , serverUrl, userId] = process.argv;

if (!serverUrl || !userId) {
  console.error('Usage: node test/manual-client.js <serverUrl> <userId>');
  process.exit(1);
}

const ws = new WebSocket(serverUrl);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function send(msg) {
  console.log('>>', msg);
  ws.send(JSON.stringify(msg));
}

ws.on('open', () => {
  console.log(`Connected to ${serverUrl} as candidate userId "${userId}"`);
  send({ type: 'register', userId });
  prompt();
});

ws.on('message', (raw) => {
  console.log('<<', raw.toString());
});

ws.on('close', () => {
  console.log('Disconnected from server');
  process.exit(0);
});

ws.on('error', (err) => {
  console.error('WebSocket error:', err.message);
});

function prompt() {
  rl.question('> ', (line) => {
    handleCommand(line.trim());
    prompt();
  });
}

function handleCommand(line) {
  const [cmd, ...rest] = line.split(' ');
  switch (cmd) {
    case 'call': {
      const [to] = rest;
      const callId = `c-${Date.now()}`;
      send({ type: 'call-invite', callId, from: userId, to });
      break;
    }
    case 'accept': {
      const [callId, peer] = rest;
      send({ type: 'call-accept', callId, from: userId, to: peer });
      break;
    }
    case 'reject': {
      const [callId, peer] = rest;
      send({ type: 'call-reject', callId, from: userId, to: peer, reason: 'declined' });
      break;
    }
    case 'cancel': {
      const [callId, peer] = rest;
      send({ type: 'call-cancel', callId, from: userId, to: peer });
      break;
    }
    case 'end': {
      const [callId, peer] = rest;
      send({ type: 'call-end', callId, from: userId, to: peer, reason: 'hangup' });
      break;
    }
    case 'quit':
      ws.close();
      rl.close();
      break;
    default:
      console.log('Unknown command. Try: call <id> | accept <callId> <peer> | reject ... | cancel ... | end ... | quit');
  }
}
