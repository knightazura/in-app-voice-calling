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

const app = express();
const webClientDir = process.env.WEB_CLIENT_DIR || path.join(__dirname, '..', 'web-client');
app.use(express.static(webClientDir));

app.get('/turn-credentials', (req, res) => {
  const userId = req.query.user || `anon-${Date.now()}`;
  res.json(mintTurnCredentials(userId));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// room -> Set<ws>, max 2 sockets per room for this 1:1 PoC
const rooms = new Map();

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const room = url.searchParams.get('room');
  const user = url.searchParams.get('user') || 'anon';

  if (!room) {
    ws.close(4000, 'room query param is required');
    return;
  }

  if (!rooms.has(room)) rooms.set(room, new Set());
  const peers = rooms.get(room);

  if (peers.size >= 2) {
    send(ws, { type: 'error', message: 'room is full (this PoC supports 1:1 calls only)' });
    ws.close(4001, 'room full');
    return;
  }

  const isFirst = peers.size === 0;
  peers.add(ws);
  ws.room = room;
  ws.user = user;

  console.log(`[join] room=${room} user=${user} role=${isFirst ? 'answerer' : 'offerer'}`);

  // The peer who joins second already knows someone is waiting, so it takes on
  // the "offerer" role and starts the SDP exchange. The first peer just waits.
  send(ws, { type: 'joined', role: isFirst ? 'answerer' : 'offerer', room });

  if (!isFirst) {
    for (const peer of peers) {
      if (peer !== ws) send(peer, { type: 'peer-joined', user });
    }
  }

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    // Signaling server never inspects SDP/ICE content, it just relays it
    // between the two participants in the room.
    for (const peer of peers) {
      if (peer !== ws) send(peer, msg);
    }
  });

  ws.on('close', () => {
    peers.delete(ws);
    for (const peer of peers) send(peer, { type: 'peer-left', user });
    if (peers.size === 0) rooms.delete(room);
    console.log(`[leave] room=${room} user=${user}`);
  });
});

server.listen(PORT, () => {
  console.log(`Signaling server listening on :${PORT}`);
  console.log(`TURN host advertised to clients: ${TURN_HOST}:${TURN_PORT}`);
});
