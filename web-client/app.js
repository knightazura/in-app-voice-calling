const userInput = document.getElementById('user');
const onlineBtn = document.getElementById('onlineBtn');
const onlineStatusEl = document.getElementById('onlineStatus');
const forceRelayInput = document.getElementById('forceRelay');

const contactsSection = document.getElementById('contacts-section');
const contactsEl = document.getElementById('contacts');

const incomingSection = document.getElementById('incoming-section');
const incomingFromEl = document.getElementById('incomingFrom');
const acceptBtn = document.getElementById('acceptBtn');
const declineBtn = document.getElementById('declineBtn');

const outgoingSection = document.getElementById('outgoing-section');
const outgoingToEl = document.getElementById('outgoingTo');
const outgoingStatusEl = document.getElementById('outgoingStatus');
const cancelBtn = document.getElementById('cancelBtn');

const callSection = document.getElementById('call-section');
const statusEl = document.getElementById('status');
const pathEl = document.getElementById('path');
const localAudio = document.getElementById('localAudio');
const remoteAudio = document.getElementById('remoteAudio');
const hangupBtn = document.getElementById('hangupBtn');

const logEl = document.getElementById('log');

let ws = null;
let myUser = null;
let currentCallId = null;
let pc = null;
let localStream = null;
let mediaReady = null; // promise, so concurrent callers of prepareMedia() share one setup
let statsTimer = null;

function log(...args) {
  console.log(...args);
  logEl.textContent += args.join(' ') + '\n';
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(s) {
  statusEl.textContent = s;
}

function wsSend(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function showOnly(section) {
  for (const el of [contactsSection, incomingSection, outgoingSection, callSection]) {
    el.style.display = el === section ? '' : 'none';
  }
}

// --- Presence: connecting this socket is like logging into the app. The server
// keeps this open so it can push a "ringing" signal at any time, not just when
// we've deliberately joined a call. ---
function connectPresence(user) {
  myUser = user;
  const wsUrl = `${location.origin.replace(/^http/, 'ws')}/ws?user=${encodeURIComponent(user)}`;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    log('[ws] online as', user);
    onlineStatusEl.textContent = 'online';
    onlineBtn.disabled = true;
    userInput.disabled = true;
    loadContacts();
    showOnly(contactsSection);
  };
  ws.onclose = () => {
    log('[ws] offline');
    onlineStatusEl.textContent = 'offline';
  };
  ws.onerror = (e) => log('[ws] error', e.message || '');
  ws.onmessage = (event) => handleMessage(JSON.parse(event.data));
}

async function loadContacts() {
  const res = await fetch('/contacts');
  const contacts = await res.json();
  contactsEl.innerHTML = '';
  for (const c of contacts.filter((c) => c.id !== myUser)) {
    const li = document.createElement('li');
    li.textContent = `${c.name} `;
    const callButton = document.createElement('button');
    callButton.textContent = 'Call';
    callButton.onclick = () => startCall(c.id, c.name);
    li.appendChild(callButton);
    contactsEl.appendChild(li);
  }
}

function startCall(to, name) {
  wsSend({ type: 'call:invite', to });
  outgoingToEl.textContent = name;
  outgoingStatusEl.textContent = 'ringing...';
  showOnly(outgoingSection);
}

// --- WebRTC setup, shared by caller (after call:accepted) and callee (after clicking Accept) ---
function prepareMedia() {
  if (!mediaReady) {
    mediaReady = (async () => {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localAudio.srcObject = localStream;

      const res = await fetch(`/turn-credentials?user=${encodeURIComponent(myUser)}`);
      const creds = await res.json();
      log('[turn] credentials issued, ttl=', creds.ttl, 's');
      const iceServers = [{ urls: creds.uris, username: creds.username, credential: creds.credential }];

      pc = new RTCPeerConnection({
        iceServers,
        iceTransportPolicy: forceRelayInput.checked ? 'relay' : 'all',
      });

      pc.onicecandidate = (event) => {
        if (event.candidate) wsSend({ type: 'candidate', candidate: event.candidate, callId: currentCallId });
      };
      pc.ontrack = (event) => {
        log('[track] remote audio track received');
        remoteAudio.srcObject = event.streams[0];
      };
      pc.onconnectionstatechange = () => {
        log('[connection]', pc.connectionState);
        setStatus(pc.connectionState);
        if (pc.connectionState === 'connected') startStatsPolling();
        if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) stopStatsPolling();
      };

      for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
    })();
  }
  return mediaReady;
}

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
    if (local && remote) pathEl.textContent = `local=${local.candidateType} remote=${remote.candidateType}`;
  }, 2000);
}

function stopStatsPolling() {
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = null;
}

function resetToContacts(message) {
  if (message) alert(message);
  stopStatsPolling();
  if (pc) pc.close();
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  pc = null;
  localStream = null;
  mediaReady = null;
  currentCallId = null;
  setStatus('idle');
  pathEl.textContent = '-';
  loadContacts();
  showOnly(contactsSection);
}

async function handleMessage(msg) {
  switch (msg.type) {
    case 'call:ringing':
      currentCallId = msg.callId;
      break;

    case 'call:unavailable':
      resetToContacts(`${msg.to} is not online right now`);
      break;

    case 'call:incoming':
      currentCallId = msg.callId;
      incomingFromEl.textContent = msg.from;
      showOnly(incomingSection);
      break;

    // Callee accepted: caller now sets up its own media/pc and makes the offer.
    case 'call:accepted': {
      outgoingStatusEl.textContent = 'connecting...';
      await prepareMedia();
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      wsSend({ type: 'offer', sdp: offer, callId: currentCallId });
      showOnly(callSection);
      break;
    }

    case 'offer':
      await prepareMedia();
      await pc.setRemoteDescription(msg.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      wsSend({ type: 'answer', sdp: answer, callId: currentCallId });
      showOnly(callSection);
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

    case 'call:declined':
      resetToContacts('Call declined');
      break;

    case 'call:cancelled':
      resetToContacts('Caller cancelled');
      break;

    case 'call:missed':
      resetToContacts('No answer');
      break;

    case 'call:ended':
      resetToContacts('Call ended');
      break;
  }
}

onlineBtn.addEventListener('click', () => {
  const user = userInput.value.trim();
  if (!user) return alert('name is required');
  connectPresence(user);
});

acceptBtn.addEventListener('click', async () => {
  wsSend({ type: 'call:accept', callId: currentCallId });
  await prepareMedia();
});

declineBtn.addEventListener('click', () => {
  wsSend({ type: 'call:decline', callId: currentCallId });
  resetToContacts();
});

cancelBtn.addEventListener('click', () => {
  wsSend({ type: 'call:cancel', callId: currentCallId });
  resetToContacts();
});

hangupBtn.addEventListener('click', () => {
  wsSend({ type: 'call:hangup', callId: currentCallId });
  resetToContacts();
});
