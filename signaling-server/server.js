const http = require('http');
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const TURN_HOST = process.env.TURN_HOST || '127.0.0.1';
const TURN_PORT = process.env.TURN_PORT || 3478;
const TURN_SECRET = process.env.TURN_SECRET || 'dev-only-shared-secret-change-me';
const TURN_REALM = process.env.TURN_REALM || 'voicecall.local';
const CRED_TTL_SECONDS = parseInt(process.env.CRED_TTL_SECONDS || '3600', 10);

// --- Mint short-lived TURN credentials (coturn REST API convention, RFC 5766 style) ---
// This is what a real backend does: never ship a static TURN username/password to
// clients. Instead issue a time-limited credential tied to the logged-in user.
function mintTurnCredentials(userId) {
  const expiry = Math.floor(Date.now() / 1000) + CRED_TTL_SECONDS;
  const username = `${expiry}:${userId}`;
  const credential = crypto
    .createHmac('sha1', TURN_SECRET)
    .update(username)
    .digest('base64');

  return {
    username,
    credential,
    ttl: CRED_TTL_SECONDS,
    uris: [
      `stun:${TURN_HOST}:${TURN_PORT}`,
      `turn:${TURN_HOST}:${TURN_PORT}?transport=udp`,
    ],
  };
}

const RING_TIMEOUT_MS = 30000;

const app = express();
const webClientDir = process.env.WEB_CLIENT_DIR || path.join(__dirname, '..', 'web-client');
app.use(express.static(webClientDir));

app.get('/turn-credentials', (req, res) => {
  const userId = req.query.user || `anon-${Date.now()}`;
  res.json(mintTurnCredentials(userId));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// userId -> ws, tracks who is currently online (like being logged into the app)
const users = new Map();
// callId -> { caller, callee, state, timeout }
const calls = new Map();

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function sendToUser(userId, payload) {
  const ws = users.get(userId);
  if (ws) send(ws, payload);
}

function otherParty(call, userId) {
  return call.caller === userId ? call.callee : call.caller;
}

// Every user gets the current online list minus themselves, pushed on any
// presence change — this is what lets the client "discover" others live
// instead of relying on a hardcoded contact book.
function broadcastPresence() {
  const online = Array.from(users.keys());
  for (const [userId, ws] of users) {
    send(ws, { type: 'presence:update', users: online.filter((u) => u !== userId) });
  }
}

function endCall(callId, notify) {
  const call = calls.get(callId);
  if (!call) return;
  clearTimeout(call.timeout);
  calls.delete(callId);
  if (notify) sendToUser(notify.to, notify.payload);
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const user = url.searchParams.get('user');

  if (!user) {
    ws.close(4000, 'user query param is required');
    return;
  }

  // Only one connection per user at a time for this PoC.
  const existing = users.get(user);
  if (existing) existing.close(4002, 'replaced by new connection');
  users.set(user, ws);
  ws.user = user;

  console.log(`[online] user=${user}`);
  broadcastPresence();

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      // --- Call setup: this is the "ringing" handshake, before any SDP is exchanged ---
      case 'call:invite': {
        const to = msg.to;
        if (to === user || !users.has(to)) {
          send(ws, { type: 'call:unavailable', to });
          return;
        }
        const callId = crypto.randomUUID();
        const call = { caller: user, callee: to, state: 'ringing' };
        call.timeout = setTimeout(() => {
          sendToUser(call.caller, { type: 'call:missed', callId });
          sendToUser(call.callee, { type: 'call:missed', callId });
          calls.delete(callId);
        }, RING_TIMEOUT_MS);
        calls.set(callId, call);
        send(ws, { type: 'call:ringing', callId, to });
        sendToUser(to, { type: 'call:incoming', callId, from: user });
        console.log(`[call:invite] ${user} -> ${to} callId=${callId}`);
        break;
      }

      case 'call:accept': {
        const call = calls.get(msg.callId);
        if (!call || call.callee !== user) return;
        clearTimeout(call.timeout);
        call.state = 'active';
        sendToUser(call.caller, { type: 'call:accepted', callId: msg.callId });
        break;
      }

      case 'call:decline': {
        const call = calls.get(msg.callId);
        if (!call || call.callee !== user) return;
        endCall(msg.callId, { to: call.caller, payload: { type: 'call:declined', callId: msg.callId } });
        break;
      }

      case 'call:cancel': {
        const call = calls.get(msg.callId);
        if (!call || call.caller !== user) return;
        endCall(msg.callId, { to: call.callee, payload: { type: 'call:cancelled', callId: msg.callId } });
        break;
      }

      case 'call:hangup': {
        const call = calls.get(msg.callId);
        if (!call) return;
        endCall(msg.callId, { to: otherParty(call, user), payload: { type: 'call:ended', callId: msg.callId } });
        break;
      }

      // --- SDP/ICE relay: server never inspects the content, just routes it to
      // the other participant in the call the message references ---
      case 'offer':
      case 'answer':
      case 'candidate': {
        const call = calls.get(msg.callId);
        if (!call) return;
        sendToUser(otherParty(call, user), msg);
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => {
    // If this connection was already replaced by a newer one for the same
    // name, don't remove the newer registration or re-broadcast for it.
    if (users.get(user) !== ws) return;
    users.delete(user);
    for (const [callId, call] of calls) {
      if (call.caller === user || call.callee === user) {
        endCall(callId, { to: otherParty(call, user), payload: { type: 'call:ended', callId } });
      }
    }
    console.log(`[offline] user=${user}`);
    broadcastPresence();
  });
});

server.listen(PORT, () => {
  console.log(`Signaling server listening on :${PORT}`);
  console.log(`TURN host advertised to clients: ${TURN_HOST}:${TURN_PORT}`);
});
