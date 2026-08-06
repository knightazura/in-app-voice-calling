# In-App Voice Call — PoC

Minimal, working proof of concept for 1:1 in-app voice calling over WebRTC:

- **`signaling-server/`** — Node.js service that relays WebRTC offer/answer/ICE
  messages between two browsers over WebSocket, and mints short-lived TURN
  credentials (this is the "service in the middle" your founder's ChatGPT
  conversation was pointing at).
- **`turn-server/`** — [coturn](https://github.com/coturn/coturn) config: a
  STUN + TURN server, the piece that makes calls work even when users are
  behind restrictive NAT/firewalls.
- **`web-client/`** — plain HTML/JS page using native `getUserMedia` +
  `RTCPeerConnection`. No build step.

Read [GUIDE.md](./GUIDE.md) for the actual technical validation, AWS options,
cost/scalability analysis, and limitations — this README is just "how to run
it."

## Run it locally

Requires Docker + Docker Compose.

```bash
cp .env.example .env
docker compose up -d --build
```

This starts:

- coturn on `127.0.0.1:3478` (STUN/TURN, UDP relay range `49160-49200`)
- signaling server + web client on `http://127.0.0.1:8080`

Open `http://127.0.0.1:8080` in **two browser tabs** (or two devices on the
same network). Use the same Room ID in both, click **Join Call** in both,
allow microphone access. You should hear audio flow between the tabs and see
the connection state turn `connected`.

### Proving the TURN relay actually works

On the same machine/network, WebRTC will usually connect directly (`host`
candidates) or via STUN (`srflx`), never touching TURN — so you won't
actually exercise the relay path, which is the part that matters for the
NAT-traversal question your founder raised.

To force it: tick **"Force TURN relay"** in both tabs before joining. This
sets `iceTransportPolicy: 'relay'`, which makes the browser refuse anything
but a TURN relay candidate. If the call still connects, and the "Connection
path" indicator shows `local=relay remote=relay`, the TURN server is
correctly authenticating and relaying — this is true regardless of whether
the two peers are on the same network or opposite sides of the planet.

Tear down:

```bash
docker compose down
```

## Known rough edges (PoC only, not production)

- No TLS — signaling runs over plain `ws://` and TURN over plain UDP. Fine for
  validation, not for anything with real users (see GUIDE.md limitations).
- One room = exactly 2 participants (rejects a 3rd) — this PoC targets 1:1
  calls only, not group calls.
- `TURN_SECRET` is a shared static secret in `.env`; a real backend would tie
  credential minting to an authenticated user session.
