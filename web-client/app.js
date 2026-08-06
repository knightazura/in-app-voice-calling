const roomInput = document.getElementById('room');
const userInput = document.getElementById('user');
const forceRelayInput = document.getElementById('forceRelay');
const joinBtn = document.getElementById('joinBtn');
const leaveBtn = document.getElementById('leaveBtn');
const statusEl = document.getElementById('status');
const pathEl = document.getElementById('path');
const localAudio = document.getElementById('localAudio');
const remoteAudio = document.getElementById('remoteAudio');
const logEl = document.getElementById('log');

let ws = null;
let pc = null;
let localStream = null;
let statsTimer = null;

function log(...args) {
  console.log(...args);
  logEl.textContent += args.join(' ') + '\n';
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(s) {
  statusEl.textContent = s;
}

async function fetchTurnCredentials(user) {
  const res = await fetch(`/turn-credentials?user=${encodeURIComponent(user)}`);
  if (!res.ok) throw new Error('failed to fetch TURN credentials');
  return res.json();
}

async function createPeerConnection(iceServers, forceRelay) {
  const conn = new RTCPeerConnection({
    iceServers,
    iceTransportPolicy: forceRelay ? 'relay' : 'all',
  });

  conn.onicecandidate = (event) => {
    if (event.candidate) {
      wsSend({ type: 'candidate', candidate: event.candidate });
    }
  };

  conn.ontrack = (event) => {
    log('[track] remote audio track received');
    remoteAudio.srcObject = event.streams[0];
  };

  conn.onconnectionstatechange = () => {
    log('[connection]', conn.connectionState);
    setStatus(conn.connectionState);
    if (conn.connectionState === 'connected') startStatsPolling();
    if (['disconnected', 'failed', 'closed'].includes(conn.connectionState)) {
      stopStatsPolling();
    }
  };

  for (const track of localStream.getTracks()) {
    conn.addTrack(track, localStream);
  }

  return conn;
}

// Inspect getStats() to find which ICE candidate pair actually carries media —
// this is how you prove whether a call went direct (host), via STUN (srflx),
// or had to be relayed through TURN.
async function startStatsPolling() {
  stopStatsPolling();
  statsTimer = setInterval(async () => {
    if (!pc) return;
    const stats = await pc.getStats();
    let selectedPairId = null;
    stats.forEach((report) => {
      if (report.type === 'transport' && report.selectedCandidatePairId) {
        selectedPairId = report.selectedCandidatePairId;
      }
    });
    if (!selectedPairId) return;

    const pair = stats.get(selectedPairId);
    if (!pair) return;
    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    if (local && remote) {
      pathEl.textContent = `local=${local.candidateType} remote=${remote.candidateType}`;
    }
  }, 2000);
}

function stopStatsPolling() {
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = null;
}

function wsSend(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

async function join() {
  const room = roomInput.value.trim();
  const user = userInput.value.trim();
  const forceRelay = forceRelayInput.checked;
  if (!room || !user) return alert('room and name are required');

  joinBtn.disabled = true;
  setStatus('requesting microphone...');

  localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  localAudio.srcObject = localStream;

  setStatus('fetching TURN credentials...');
  const creds = await fetchTurnCredentials(user);
  const iceServers = [{ urls: creds.uris, username: creds.username, credential: creds.credential }];
  log('[turn] credentials issued, ttl=', creds.ttl, 's');

  pc = await createPeerConnection(iceServers, forceRelay);

  setStatus('connecting to signaling server...');
  const wsUrl = `${location.origin.replace(/^http/, 'ws')}/ws?room=${encodeURIComponent(room)}&user=${encodeURIComponent(user)}`;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => log('[ws] connected');
  ws.onclose = () => log('[ws] closed');
  ws.onerror = (e) => log('[ws] error', e.message || '');

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);

    switch (msg.type) {
      case 'joined':
        log('[signaling] joined as', msg.role);
        setStatus(`waiting for peer (role=${msg.role})`);
        if (msg.role === 'offerer') {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          wsSend({ type: 'offer', sdp: offer });
        }
        break;

      case 'peer-joined':
        log('[signaling] peer joined, waiting for offer');
        break;

      case 'offer':
        await pc.setRemoteDescription(msg.sdp);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        wsSend({ type: 'answer', sdp: answer });
        break;

      case 'answer':
        await pc.setRemoteDescription(msg.sdp);
        break;

      case 'candidate':
        try {
          await pc.addIceCandidate(msg.candidate);
        } catch (err) {
          log('[ice] failed to add candidate', err.message);
        }
        break;

      case 'peer-left':
        log('[signaling] peer left');
        setStatus('peer left');
        pathEl.textContent = '-';
        break;

      case 'error':
        log('[signaling] error:', msg.message);
        alert(msg.message);
        leave();
        break;
    }
  };

  leaveBtn.disabled = false;
}

function leave() {
  stopStatsPolling();
  if (ws) ws.close();
  if (pc) pc.close();
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  ws = null;
  pc = null;
  localStream = null;
  setStatus('idle');
  pathEl.textContent = '-';
  joinBtn.disabled = false;
  leaveBtn.disabled = true;
}

joinBtn.addEventListener('click', () => join().catch((err) => {
  log('[error]', err.message);
  alert(err.message);
  joinBtn.disabled = false;
}));
leaveBtn.addEventListener('click', leave);
