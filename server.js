const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_FILE = process.env.DATA_FILE || '/data/tokens.json';
const PORT = process.env.PORT || 3051;
const BASE_URL = process.env.BASE_URL || 'http://confirm.mesh';
const TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes

const NATO = [
  'ALPHA','BRAVO','CHARLIE','DELTA','ECHO','FOXTROT','GOLF','HOTEL',
  'INDIA','JULIET','KILO','LIMA','MIKE','NOVEMBER','OSCAR','PAPA',
  'QUEBEC','ROMEO','SIERRA','TANGO','UNIFORM','VICTOR','WHISKEY',
  'XRAY','YANKEE','ZULU'
];

// --- Persistent store (file-backed Map) ---
let store = {};

function loadStore() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) {
    console.warn('Could not load store, starting fresh:', e.message);
    store = {};
  }
}

function saveStore() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

function pruneExpired() {
  const now = Date.now();
  let changed = false;
  for (const [id, t] of Object.entries(store)) {
    if (t.expires_at < now - 60000) {
      delete store[id];
      changed = true;
    }
  }
  if (changed) saveStore();
}

loadStore();
setInterval(pruneExpired, 60 * 60 * 1000);

// --- Helpers ---
function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

function generateCode() {
  const w1 = NATO[Math.floor(Math.random() * NATO.length)];
  const w2 = NATO[Math.floor(Math.random() * NATO.length)];
  const num = Math.floor(Math.random() * 9000) + 1000;
  return `${w1}-${num}-${w2}`;
}

// --- Routes ---

// Agent calls this to create a confirmation request
app.post('/api/request', (req, res) => {
  const { action, details } = req.body;
  if (!action) return res.status(400).json({ error: 'action required' });

  const token = generateToken();
  const now = Date.now();
  store[token] = {
    action,
    details: details || '',
    status: 'pending',
    code: null,
    created_at: now,
    expires_at: now + TOKEN_TTL_MS
  };
  saveStore();

  res.json({
    token,
    url: `${BASE_URL}/confirm/${token}`,
    expires_in: 300
  });
});

// Page fetches token info
app.get('/api/token/:token', (req, res) => {
  const t = store[req.params.token];
  if (!t) return res.status(404).json({ error: 'not found' });
  if (t.expires_at < Date.now()) return res.status(410).json({ error: 'expired' });
  if (t.status !== 'pending') return res.status(409).json({ error: 'already used' });
  res.json({ action: t.action, details: t.details });
});

// User clicks the button
app.post('/api/confirm/:token', (req, res) => {
  const t = store[req.params.token];
  if (!t) return res.status(404).json({ error: 'not found' });
  if (t.expires_at < Date.now()) return res.status(410).json({ error: 'expired' });
  if (t.status !== 'pending') return res.status(409).json({ error: 'already used' });

  const code = generateCode();
  t.status = 'confirmed';
  t.code = code;
  saveStore();

  res.json({ code });
});

// Agent calls this to verify the code the user pasted back
app.post('/api/verify', (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code required' });

  const entry = Object.entries(store).find(
    ([, t]) => t.code === code.trim().toUpperCase() && t.status === 'confirmed'
  );
  if (!entry) return res.status(404).json({ valid: false, error: 'invalid or already used code' });

  const [id, t] = entry;
  if (t.expires_at < Date.now()) return res.status(410).json({ valid: false, error: 'expired' });

  t.status = 'used';
  saveStore();

  res.json({ valid: true, action: t.action, details: t.details });
});

// Serve confirm page for any token route
app.get('/confirm/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'confirm.html'));
});

app.listen(PORT, () => console.log(`confirm-service running on :${PORT}`));
