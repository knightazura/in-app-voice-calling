const userInput = document.getElementById("user");
const onlineBtn = document.getElementById("onlineBtn");
const iceModeSelect = document.getElementById("iceMode");

const screens = {
  signin: document.getElementById("screen-signin"),
  contacts: document.getElementById("screen-contacts"),
  incoming: document.getElementById("screen-incoming"),
  outgoing: document.getElementById("screen-outgoing"),
  call: document.getElementById("screen-call"),
};

const myAvatarEl = document.getElementById("myAvatar");
const myNameEl = document.getElementById("myName");
const contactsEl = document.getElementById("contacts");

const incomingAvatarEl = document.getElementById("incomingAvatar");
const incomingFromEl = document.getElementById("incomingFrom");
const acceptBtn = document.getElementById("acceptBtn");
const declineBtn = document.getElementById("declineBtn");

const outgoingAvatarEl = document.getElementById("outgoingAvatar");
const outgoingToEl = document.getElementById("outgoingTo");
const outgoingStatusEl = document.getElementById("outgoingStatus");
const cancelBtn = document.getElementById("cancelBtn");

const callAvatarEl = document.getElementById("callAvatar");
const callWithNameEl = document.getElementById("callWithName");
const callTimerEl = document.getElementById("callTimer");
const connectionBadgeEl = document.getElementById("connectionBadge");
const localAudio = document.getElementById("localAudio");
const remoteAudio = document.getElementById("remoteAudio");
const muteBtn = document.getElementById("muteBtn");
const hangupBtn = document.getElementById("hangupBtn");

const logEl = document.getElementById("log");
const logToggle = document.getElementById("logToggle");
const logWrap = document.getElementById("logWrap");

const settingsModal = document.getElementById("settingsModal");
const openSettingsSignin = document.getElementById("openSettingsSignin");
const openSettingsContacts = document.getElementById("openSettingsContacts");
const closeSettingsBtn = document.getElementById("closeSettings");

let ws = null;
let myUser = null;
let currentCallId = null;
let currentPeer = null;
let pc = null;
let localStream = null;
let mediaReady = null; // promise, so concurrent callers of prepareMedia() share one setup
let statsTimer = null;
let callTimerInterval = null;
let callStartTime = null;
let isMuted = false;

function log(...args) {
  console.log(...args);
  logEl.textContent += args.join(" ") + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}

function wsSend(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function showScreen(name) {
  for (const key in screens)
    screens[key].classList.toggle("active", key === name);
}

// --- Avatars: simple initials + a color hashed from the name, so contacts
// are visually distinguishable without needing real profile pictures. ---
function initialsFor(name) {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function colorFor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++)
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return `hsl(${Math.abs(hash) % 360}, 60%, 50%)`;
}

function setAvatar(el, name) {
  el.style.background = colorFor(name);
  el.textContent = initialsFor(name);
}

// --- Presence: connecting this socket is like logging into the app. The server
// keeps this open so it can push a "ringing" signal at any time, not just when
// we've deliberately joined a call. ---
function connectPresence(user) {
  myUser = user;
  const wsUrl = `${location.origin.replace(/^http/, "ws")}/ws?user=${encodeURIComponent(user)}`;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    log("[ws] online as", user);
    myNameEl.textContent = user;
    setAvatar(myAvatarEl, user);
    showScreen("contacts");
  };
  ws.onclose = () => log("[ws] offline");
  ws.onerror = (e) => log("[ws] error", e.message || "");
  ws.onmessage = (event) => handleMessage(JSON.parse(event.data));
}

// Renders whoever else is currently online, as pushed by the server's
// presence:update broadcast — no predefined contact list.
function renderOnlineUsers(others) {
  contactsEl.innerHTML = "";
  if (others.length === 0) {
    const li = document.createElement("li");
    li.className = "empty-state";
    li.textContent = "No one else is online yet…";
    contactsEl.appendChild(li);
    return;
  }
  for (const userId of others) {
    const li = document.createElement("li");
    li.className = "contact-row";

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    setAvatar(avatar, userId);

    const name = document.createElement("div");
    name.className = "contact-name";
    name.textContent = userId;

    const callButton = document.createElement("button");
    callButton.className = "call-icon-btn";
    callButton.setAttribute("aria-label", `Call ${userId}`);
    callButton.innerHTML =
      '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>';
    callButton.onclick = () => startCall(userId);

    li.appendChild(avatar);
    li.appendChild(name);
    li.appendChild(callButton);
    contactsEl.appendChild(li);
  }
}

function startCall(to) {
  currentPeer = to;
  wsSend({ type: "call:invite", to });
  outgoingToEl.textContent = to;
  setAvatar(outgoingAvatarEl, to);
  outgoingStatusEl.textContent = "Ringing…";
  showScreen("outgoing");
}

// --- WebRTC setup, shared by caller (after call:accepted) and callee (after clicking Accept) ---
function prepareMedia() {
  if (!mediaReady) {
    mediaReady = (async () => {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localAudio.srcObject = localStream;

      const res = await fetch(
        `/turn-credentials?user=${encodeURIComponent(myUser)}`,
      );
      const creds = await res.json();
      log("[turn] credentials issued, ttl=", creds.ttl, "s");

      const iceMode = iceModeSelect.value;
      log("[ice] mode =", iceMode);

      // "no-turn" strips the turn: URI out of iceServers entirely, so ICE never
      // gathers relay candidates and never has a TURN path to silently fall back
      // to — a stalled/failed connection then means direct/STUN really is blocked.
      const iceServers =
        iceMode === "no-turn"
          ? [{ urls: creds.uris.filter((u) => u.startsWith("stun:")) }]
          : [
              {
                urls: creds.uris,
                username: creds.username,
                credential: creds.credential,
              },
            ];

      pc = new RTCPeerConnection({
        iceServers,
        iceTransportPolicy: iceMode === "relay" ? "relay" : "all",
      });

      pc.onicecandidate = (event) => {
        if (event.candidate)
          wsSend({
            type: "candidate",
            candidate: event.candidate,
            callId: currentCallId,
          });
      };
      pc.ontrack = (event) => {
        log("[track] remote audio track received");
        remoteAudio.srcObject = event.streams[0];
      };
      pc.onconnectionstatechange = () => {
        log("[connection]", pc.connectionState);
        if (pc.connectionState === "connected") {
          startCallTimer();
          startStatsPolling();
        }
        if (["disconnected", "failed", "closed"].includes(pc.connectionState))
          stopStatsPolling();
      };

      for (const track of localStream.getTracks())
        pc.addTrack(track, localStream);
    })();
  }
  return mediaReady;
}

function startCallTimer() {
  if (callTimerInterval) return;
  callStartTime = Date.now();
  callTimerInterval = setInterval(updateCallTimer, 1000);
  updateCallTimer();
}

function updateCallTimer() {
  const secs = Math.floor((Date.now() - callStartTime) / 1000);
  const m = String(Math.floor(secs / 60)).padStart(2, "0");
  const s = String(secs % 60).padStart(2, "0");
  callTimerEl.textContent = `${m}:${s}`;
}

function stopCallTimer() {
  if (callTimerInterval) clearInterval(callTimerInterval);
  callTimerInterval = null;
  callTimerEl.textContent = "Connecting…";
}

// Keep the raw candidate types out of the main UI (too technical) but surface
// a plain-language summary of whether the call is peer-to-peer or relayed.
async function startStatsPolling() {
  stopStatsPolling();
  statsTimer = setInterval(async () => {
    if (!pc) return;
    const stats = await pc.getStats();
    let selectedPairId = null;
    stats.forEach((report) => {
      if (report.type === "transport" && report.selectedCandidatePairId) {
        selectedPairId = report.selectedCandidatePairId;
      }
    });
    if (!selectedPairId) return;
    const pair = stats.get(selectedPairId);
    if (!pair) return;
    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    if (!local || !remote) return;

    const isRelayed =
      local.candidateType === "relay" || remote.candidateType === "relay";
    connectionBadgeEl.textContent = isRelayed
      ? "Connected via relay server"
      : "Direct connection";
    connectionBadgeEl.title = `local=${local.candidateType} remote=${remote.candidateType}`;
    connectionBadgeEl.classList.remove("hidden");
  }, 2000);
}

function stopStatsPolling() {
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = null;
}

function resetToContacts(message) {
  if (message) alert(message);
  stopStatsPolling();
  stopCallTimer();
  if (pc) pc.close();
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  pc = null;
  localStream = null;
  mediaReady = null;
  currentCallId = null;
  currentPeer = null;
  isMuted = false;
  muteBtn.classList.remove("active");
  connectionBadgeEl.classList.add("hidden");
  showScreen("contacts");
}

async function handleMessage(msg) {
  switch (msg.type) {
    case "presence:update":
      renderOnlineUsers(msg.users);
      break;

    case "call:ringing":
      currentCallId = msg.callId;
      break;

    case "call:unavailable":
      resetToContacts(`${msg.to} is not online right now`);
      break;

    case "call:incoming":
      currentCallId = msg.callId;
      currentPeer = msg.from;
      incomingFromEl.textContent = msg.from;
      setAvatar(incomingAvatarEl, msg.from);
      showScreen("incoming");
      break;

    // Callee accepted: caller now sets up its own media/pc and makes the offer.
    case "call:accepted": {
      outgoingStatusEl.textContent = "Connecting…";
      await prepareMedia();
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      wsSend({ type: "offer", sdp: offer, callId: currentCallId });
      callWithNameEl.textContent = currentPeer;
      setAvatar(callAvatarEl, currentPeer);
      showScreen("call");
      break;
    }

    case "offer":
      await prepareMedia();
      await pc.setRemoteDescription(msg.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      wsSend({ type: "answer", sdp: answer, callId: currentCallId });
      callWithNameEl.textContent = currentPeer;
      setAvatar(callAvatarEl, currentPeer);
      showScreen("call");
      break;

    case "answer":
      await pc.setRemoteDescription(msg.sdp);
      break;

    case "candidate":
      try {
        await pc.addIceCandidate(msg.candidate);
      } catch (err) {
        log("[ice] failed to add candidate", err.message);
      }
      break;

    case "call:declined":
      resetToContacts("Call declined");
      break;

    case "call:cancelled":
      resetToContacts("Caller cancelled");
      break;

    case "call:missed":
      resetToContacts("No answer");
      break;

    case "call:ended":
      resetToContacts("Call ended");
      break;
  }
}

onlineBtn.addEventListener("click", () => {
  const user = userInput.value.trim();
  if (!user) return alert("name is required");
  connectPresence(user);
});

userInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") onlineBtn.click();
});

acceptBtn.addEventListener("click", async () => {
  wsSend({ type: "call:accept", callId: currentCallId });
  await prepareMedia();
});

declineBtn.addEventListener("click", () => {
  wsSend({ type: "call:decline", callId: currentCallId });
  resetToContacts();
});

cancelBtn.addEventListener("click", () => {
  wsSend({ type: "call:cancel", callId: currentCallId });
  resetToContacts();
});

hangupBtn.addEventListener("click", () => {
  wsSend({ type: "call:hangup", callId: currentCallId });
  resetToContacts();
});

muteBtn.addEventListener("click", () => {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach((t) => (t.enabled = !isMuted));
  muteBtn.classList.toggle("active", isMuted);
  muteBtn.setAttribute("aria-label", isMuted ? "Unmute" : "Mute");
});

// --- Settings modal: houses everything too technical for the main flow
// (connection mode, verbose log) — hidden by default, opt-in only. ---
function openSettings() {
  settingsModal.classList.remove("hidden");
}
function closeSettings() {
  settingsModal.classList.add("hidden");
}
openSettingsSignin.addEventListener("click", openSettings);
openSettingsContacts.addEventListener("click", openSettings);
closeSettingsBtn.addEventListener("click", closeSettings);
settingsModal.addEventListener("click", (e) => {
  if (e.target === settingsModal) closeSettings();
});
logToggle.addEventListener("change", () => {
  logWrap.classList.toggle("hidden", !logToggle.checked);
});
