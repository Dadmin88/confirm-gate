const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3051;
const DATA_FILE = process.env.DATA_FILE || '/data/tokens.json';
const CONFIG_FILE = process.env.CONFIG_FILE || '/data/config.json';
const BASE_URL = process.env.BASE_URL || 'http://confirm.mesh';
const TOKEN_TTL_MS = 5 * 60 * 1000;
const RESET_TTL_MS = 15 * 60 * 1000;

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587');
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;

const NATO = [
  'ALPHA','BRAVO','CHARLIE','DELTA','ECHO','FOXTROT','GOLF','HOTEL',
  'INDIA','JULIET','KILO','LIMA','MIKE','NOVEMBER','OSCAR','PAPA',
  'QUEBEC','ROMEO','SIERRA','TANGO','UNIFORM','VICTOR','WHISKEY',
  'XRAY','YANKEE','ZULU'
];

// --- Rate limiter ---
const rateLimits = new Map();
function checkRateLimit(ip, max = 10) {
  const now = Date.now();
  if (!rateLimits.has(ip)) rateLimits.set(ip, []);
  const hits = rateLimits.get(ip).filter(t => now - t < 60000);
  hits.push(now);
  rateLimits.set(ip, hits);
  return hits.length <= max;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, hits] of rateLimits.entries()) {
    const fresh = hits.filter(t => now - t < 60000);
    if (!fresh.length) rateLimits.delete(ip); else rateLimits.set(ip, fresh);
  }
}, 5 * 60 * 1000);

// --- Token store ---
let store = {};
function loadStore() {
  try { if (fs.existsSync(DATA_FILE)) store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { store = {}; }
}
function saveStore() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [id, t] of Object.entries(store)) {
    if (t.expires_at < now - 60000) { delete store[id]; changed = true; }
  }
  if (changed) saveStore();
}, 60 * 60 * 1000);
loadStore();

// --- Config (PIN + email) ---
let config = { setup_complete: false, pin_hash: null, pin_salt: null, email: null, reset_tokens: {} };
function loadConfig() {
  try { if (fs.existsSync(CONFIG_FILE)) config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; } catch {}
}
function saveConfig() {
  const dir = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}
loadConfig();

// --- PIN helpers ---
function hashPin(pin, salt) {
  return crypto.pbkdf2Sync(pin, salt, 100000, 32, 'sha256').toString('hex');
}
function verifyPin(pin) {
  if (!config.pin_hash || !config.pin_salt) return true; // no PIN set
  return hashPin(pin, config.pin_salt) === config.pin_hash;
}

// --- Email ---
async function sendEmail(to, subject, html) {
  if (!SMTP_HOST) throw new Error('SMTP not configured');
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST, port: SMTP_PORT,
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
    secure: SMTP_PORT === 465
  });
  await transporter.sendMail({ from: SMTP_FROM, to, subject, html });
}

// --- Helpers ---
function generateToken() { return crypto.randomBytes(16).toString('hex'); }
function generateCode() {
  const w1 = NATO[Math.floor(Math.random() * NATO.length)];
  const w2 = NATO[Math.floor(Math.random() * NATO.length)];
  return `${w1}-${Math.floor(Math.random() * 9000) + 1000}-${w2}`;
}
function getIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
}

// --- Setup routes ---
app.get('/setup', (req, res) => res.sendFile(path.join(__dirname, 'public', 'setup.html')));
app.get('/forgot-pin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'forgot-pin.html')));
app.get('/reset-pin/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'reset-pin.html')));

app.get('/api/setup-status', (req, res) => {
  res.json({
    setup_complete: config.setup_complete,
    has_email: !!config.email,
    smtp_configured: !!SMTP_HOST
  });
});

app.post('/api/setup', (req, res) => {
  if (config.setup_complete) return res.status(409).json({ error: 'Already set up. Use forgot PIN to reset.' });
  const { pin, email } = req.body;
  if (!pin || pin.length < 4) return res.status(400).json({ error: 'PIN must be at least 4 characters.' });
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required for PIN recovery.' });
  const salt = crypto.randomBytes(16).toString('hex');
  config.pin_hash = hashPin(pin, salt);
  config.pin_salt = salt;
  config.email = email;
  config.setup_complete = true;
  saveConfig();
  res.json({ ok: true });
});

app.post('/api/forgot-pin', async (req, res) => {
  const ip = getIp(req);
  if (!checkRateLimit(ip, 3)) return res.status(429).json({ error: 'Too many attempts.' });
  if (!config.setup_complete || !config.email) return res.status(404).json({ error: 'No account configured.' });
  if (!SMTP_HOST) return res.status(503).json({ error: 'Email not configured on this server.' });

  const token = generateToken();
  if (!config.reset_tokens) config.reset_tokens = {};
  config.reset_tokens[token] = { expires_at: Date.now() + RESET_TTL_MS };
  saveConfig();

  const resetUrl = `${BASE_URL}/reset-pin/${token}`;
  try {
    await sendEmail(config.email, 'confirm-gate: PIN Reset', `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2 style="color:#c0392b">PIN Reset Request</h2>
        <p>A PIN reset was requested for your confirm-gate. Click the link below to set a new PIN.</p>
        <p style="margin:24px 0">
          <a href="${resetUrl}" style="background:#c0392b;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold">
            Reset PIN
          </a>
        </p>
        <p style="color:#888;font-size:12px">This link expires in 15 minutes. If you didn't request this, ignore this email.</p>
      </div>
    `);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to send email: ' + e.message });
  }
});

app.get('/api/reset-token/:token', (req, res) => {
  const t = config.reset_tokens?.[req.params.token];
  if (!t || t.expires_at < Date.now()) return res.status(410).json({ error: 'Invalid or expired reset link.' });
  res.json({ ok: true });
});

app.post('/api/reset-pin/:token', (req, res) => {
  const t = config.reset_tokens?.[req.params.token];
  if (!t || t.expires_at < Date.now()) return res.status(410).json({ error: 'Invalid or expired reset link.' });
  const { pin } = req.body;
  if (!pin || pin.length < 4) return res.status(400).json({ error: 'PIN must be at least 4 characters.' });
  const salt = crypto.randomBytes(16).toString('hex');
  config.pin_hash = hashPin(pin, salt);
  config.pin_salt = salt;
  delete config.reset_tokens[req.params.token];
  saveConfig();
  res.json({ ok: true });
});

// --- Confirmation routes ---
app.post('/api/request', (req, res) => {
  const { action, details } = req.body;
  if (!action) return res.status(400).json({ error: 'action required' });
  const token = generateToken();
  const now = Date.now();
  store[token] = { action, details: details || '', status: 'pending', code: null, created_at: now, expires_at: now + TOKEN_TTL_MS };
  saveStore();
  res.json({ token, url: `${BASE_URL}/confirm/${token}`, expires_in: 300 });
});

app.get('/api/token/:token', (req, res) => {
  if (!config.setup_complete) return res.status(503).json({ error: 'setup_required', redirect: '/setup' });
  const t = store[req.params.token];
  if (!t) return res.status(404).json({ error: 'not found' });
  if (t.expires_at < Date.now()) return res.status(410).json({ error: 'expired' });
  if (t.status !== 'pending') return res.status(409).json({ error: 'already used' });
  res.json({ action: t.action, details: t.details, expires_at: t.expires_at, pin_required: !!config.pin_hash });
});

app.post('/api/confirm/:token', (req, res) => {
  const ip = getIp(req);
  if (!checkRateLimit(ip, 10)) return res.status(429).json({ error: 'Too many attempts.' });
  const t = store[req.params.token];
  if (!t) return res.status(404).json({ error: 'not found' });
  if (t.expires_at < Date.now()) return res.status(410).json({ error: 'expired' });
  if (t.status !== 'pending') return res.status(409).json({ error: 'already used' });
  if (config.pin_hash) {
    if (!verifyPin((req.body?.pin || '').trim())) return res.status(403).json({ error: 'Invalid PIN' });
  }
  const code = generateCode();
  t.status = 'confirmed';
  t.code = code;
  saveStore();
  res.json({ code });
});

app.post('/api/verify', (req, res) => {
  const ip = getIp(req);
  if (!checkRateLimit(ip, 10)) return res.status(429).json({ valid: false, error: 'Too many attempts.' });
  const { code, token } = req.body;
  if (!code) return res.status(400).json({ error: 'code required' });

  let id, t;
  if (token) {
    // Preferred: token + code — prevents cross-request mixup
    t = store[token];
    if (!t || t.code !== code.trim().toUpperCase() || t.status !== 'confirmed') {
      return res.status(404).json({ valid: false, error: 'invalid or already used code' });
    }
    id = token;
  } else {
    // Backward-compatible: code-only search
    const entry = Object.entries(store).find(([, t]) => t.code === code.trim().toUpperCase() && t.status === 'confirmed');
    if (!entry) return res.status(404).json({ valid: false, error: 'invalid or already used code' });
    [id, t] = entry;
  }

  if (t.expires_at < Date.now()) return res.status(410).json({ valid: false, error: 'expired' });
  t.status = 'used';
  saveStore();
  res.json({ valid: true, action: t.action, details: t.details });
});

app.get('/confirm/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'confirm.html')));

app.listen(PORT, () => console.log(`confirm-gate :${PORT} | setup: ${config.setup_complete}`));
