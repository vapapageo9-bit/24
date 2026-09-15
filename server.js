const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const os = require('os');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// Both roles are served by the same page; the browser reads the URL path
// and decides whether to show the controls (/control) or hide them (/display).
// "/" still works and behaves like /control, so existing links keep working.
app.get(['/display', '/control'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---- Shared authoritative state (same for every connected device) ----
//
// Timing is timestamp-based, not tick-based: while the clock runs we only
// remember when it started (startedAt) and how much time was on it at that
// moment (remainingAtStart). The current value is always DERIVED from the
// real wall clock, so a slow/skipped interval can never make the clock drift.
const state = {
  mode: 24,               // 24 or 14 (what a full reset means right now)
  running: false,
  buzzer: false,          // pulsed true for a moment when it hits 0
  remainingAtStart: 24.0, // seconds left when the clock was last started/set
  startedAt: null,        // Date.now() when it was last started, null if stopped
};

const TICK_MS = 100; // how often we push an update to clients (display only)

// Derive the true current time left from real elapsed time.
function computeTimeLeft() {
  if (!state.running || state.startedAt === null) {
    return Math.max(0, state.remainingAtStart);
  }
  const elapsed = (Date.now() - state.startedAt) / 1000;
  return Math.max(0, state.remainingAtStart - elapsed);
}

// Freeze the derived value back into remainingAtStart and stop the clock.
function stopClock() {
  state.remainingAtStart = computeTimeLeft();
  state.running = false;
  state.startedAt = null;
}

// Start (or resume) counting down from whatever is currently on the clock.
function startClock() {
  if (computeTimeLeft() <= 0) return;
  state.remainingAtStart = computeTimeLeft();
  state.startedAt = Date.now();
  state.running = true;
}

// Load a specific value onto the clock, stopped and ready to start.
function setClock(seconds) {
  state.remainingAtStart = Math.max(0, seconds);
  state.running = false;
  state.startedAt = null;
  state.buzzer = false;
}

function broadcast() {
  const msg = JSON.stringify({
    type: 'state',
    timeLeft: Math.round(computeTimeLeft() * 100) / 100,
    mode: state.mode,
    running: state.running,
    buzzer: state.buzzer,
  });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

setInterval(() => {
  // Expiry is detected from the derived time, so it fires at the right real
  // moment even if this interval ran late.
  if (state.running && computeTimeLeft() <= 0) {
    state.remainingAtStart = 0;
    state.running = false;
    state.startedAt = null;
    state.buzzer = true;
    broadcast();
    setTimeout(() => { state.buzzer = false; }, 1500);
    return;
  }
  broadcast();
}, TICK_MS);

function handleCommand(cmd) {
  switch (cmd.type) {
    // Toggle start/stop for the 24s clock. If we're not already in 24 mode,
    // switch to it, load 24.0 and start running immediately.
    case 'toggle24':
      if (state.mode !== 24) {
        state.mode = 24;
        setClock(24);
        startClock();
      } else if (state.running) {
        stopClock();
      } else {
        startClock();
      }
      break;

    // Same behaviour for the 14s clock.
    case 'toggle14':
      if (state.mode !== 14) {
        state.mode = 14;
        setClock(14);
        startClock();
      } else if (state.running) {
        stopClock();
      } else {
        startClock();
      }
      break;

    // Single reset: reloads whichever mode is currently active (24 or 14)
    // back to its full value and stops the clock.
    case 'reset':
      setClock(state.mode);
      break;

    // Manual override: operator types in a custom time (e.g. 7.3) and it
    // gets loaded into the clock immediately, stopped, ready to start.
    case 'setTime': {
      const value = Number(cmd.value);
      if (Number.isFinite(value) && value >= 0 && value <= 99) {
        setClock(Math.round(value * 10) / 10); // keep one decimal
      }
      break;
    }

    default:
      break;
  }
  broadcast();
}

wss.on('connection', (ws) => {
  // send current state immediately to the newly connected device
  ws.send(JSON.stringify({ type: 'state', ...state }));

  ws.on('message', (data) => {
    try {
      const cmd = JSON.parse(data);
      handleCommand(cmd);
    } catch (e) {
      // ignore malformed messages
    }
  });
});

function getLocalIPs() {
  const ifaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
    }
  }
  return ips;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n24/14 Shot Clock server running!`);
  console.log(`  Local:   http://localhost:${PORT}`);
  getLocalIPs().forEach((ip) => {
    console.log(`  Network: http://${ip}:${PORT}   <-- use this link on other devices`);
  });
  console.log(`\nAll devices that open one of the links above will see the SAME clock.\n`);
});
