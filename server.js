// Planning Effectifs — Node.js backend
//
// Real SQLite database + push updates over Server-Sent Events (SSE), so every
// connected browser sees changes within milliseconds instead of the 12-30s
// polling delay of the previous Google Apps Script backend.
//
// No plaintext password is ever stored: only a per-user random salt + a
// salted SHA-256 hash.

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'planning.db');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const RESTORE_PENDING_PATH = path.join(DATA_DIR, 'restore-pending.db');
const BACKUP_RETENTION_DAYS = 7;
const BACKUP_HOURS = [10, 14, 16, 20, 22]; // local server time
const RCLONE_REMOTE = 'gdrive:Planning-Backups';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });

// If a restore was requested (see /api/backups/restore), swap the uploaded
// file in before opening the live database, backing up what was there first.
// The previous process may have exited without checkpointing its WAL file,
// so open the old database (SQLite auto-recovers the WAL on open) and use
// VACUUM INTO to produce one consistent, complete backup file rather than a
// raw copy that could miss whatever was still sitting in -wal/-shm.
if (fs.existsSync(RESTORE_PENDING_PATH)) {
  if (fs.existsSync(DB_PATH)) {
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
    const safetyBackupPath = path.join(BACKUP_DIR, `avant-restauration-${stamp}.db`);
    try {
      const oldDb = new Database(DB_PATH);
      oldDb.prepare('VACUUM INTO ?').run(safetyBackupPath);
      oldDb.close();
    } catch (err) {
      console.error('Could not snapshot the pre-restore database cleanly, falling back to a raw copy:', err.message);
      fs.copyFileSync(DB_PATH, safetyBackupPath);
    }
  }
  fs.renameSync(RESTORE_PENDING_PATH, DB_PATH);
  for (const ext of ['-wal', '-shm']) {
    try { fs.unlinkSync(DB_PATH + ext); } catch (err) { /* nothing to remove — fine */ }
  }
  console.log('Restored database from an uploaded backup file.');
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    salt TEXT NOT NULL,
    hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','planning','user'))
  );
  CREATE TABLE IF NOT EXISTS employees (
    id TEXT PRIMARY KEY,
    company TEXT NOT NULL,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    "order" INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS vehicles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    "order" INTEGER NOT NULL DEFAULT 0,
    type TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS dossiers (
    id TEXT PRIMARY KEY,
    client TEXT NOT NULL DEFAULT '',
    startDate TEXT NOT NULL,
    endDate TEXT NOT NULL,
    addressFrom TEXT DEFAULT '',
    addressTo TEXT DEFAULT '',
    volume TEXT DEFAULT '',
    seller TEXT DEFAULT '',
    coordinator TEXT DEFAULT '',
    task TEXT DEFAULT '',
    moveType TEXT DEFAULT '',
    createdAt INTEGER DEFAULT 0,
    displayOrder INTEGER DEFAULT 0,
    sameResourcesAllDays INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS assignments (
    id TEXT PRIMARY KEY,
    dossierId TEXT NOT NULL,
    date TEXT NOT NULL,
    employeesJson TEXT NOT NULL DEFAULT '[]',
    vehicleIdsJson TEXT NOT NULL DEFAULT '[]',
    arrivalTime TEXT DEFAULT '',
    slot TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS absences (
    id TEXT PRIMARY KEY,
    employeeId TEXT NOT NULL,
    reason TEXT NOT NULL,
    startDate TEXT NOT NULL,
    endDate TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS vehicle_downtimes (
    id TEXT PRIMARY KEY,
    vehicleId TEXT NOT NULL,
    reason TEXT NOT NULL,
    startDate TEXT NOT NULL,
    endDate TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS dossier_history (
    id TEXT PRIMARY KEY,
    dossierId TEXT NOT NULL,
    field TEXT NOT NULL,
    oldValue TEXT DEFAULT '',
    newValue TEXT DEFAULT '',
    changedBy TEXT DEFAULT '',
    changedAt INTEGER NOT NULL
  );
`);

// ---------- migrations for columns added after initial release ----------
(function migrateVehicleType() {
  const cols = db.prepare("PRAGMA table_info(vehicles)").all().map(c => c.name);
  if (!cols.includes('type')) {
    db.exec("ALTER TABLE vehicles ADD COLUMN type TEXT NOT NULL DEFAULT ''");
  }
  if (!cols.includes('capacity')) {
    db.exec("ALTER TABLE vehicles ADD COLUMN capacity TEXT NOT NULL DEFAULT ''");
  }
})();
(function migrateDossierDisplayOrder() {
  const cols = db.prepare("PRAGMA table_info(dossiers)").all().map(c => c.name);
  if (!cols.includes('displayOrder')) {
    db.exec("ALTER TABLE dossiers ADD COLUMN displayOrder INTEGER NOT NULL DEFAULT 0");
  }
  if (!cols.includes('sameResourcesAllDays')) {
    db.exec("ALTER TABLE dossiers ADD COLUMN sameResourcesAllDays INTEGER NOT NULL DEFAULT 0");
  }
  if (!cols.includes('dossierNumber')) {
    db.exec("ALTER TABLE dossiers ADD COLUMN dossierNumber TEXT NOT NULL DEFAULT ''");
  }
  if (!cols.includes('comment')) {
    db.exec("ALTER TABLE dossiers ADD COLUMN comment TEXT NOT NULL DEFAULT ''");
  }
})();

// ---------- backups ----------
// A hot, consistent snapshot via SQLite's own VACUUM INTO (safe even while
// the live database is being written to). Kept for BACKUP_RETENTION_DAYS on
// the VPS; also pushed to Google Drive via rclone if it's configured — Drive
// is the backup of last resort and is never pruned by this app.
function backupFileName(d) {
  const p = n => String(n).padStart(2, '0');
  return `planning-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}h${p(d.getMinutes())}.db`;
}
function pruneOldBackups() {
  const cutoff = Date.now() - BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const f of fs.readdirSync(BACKUP_DIR)) {
    const full = path.join(BACKUP_DIR, f);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
    } catch (err) { /* file may have been removed concurrently — ignore */ }
  }
}
const RCLONE_CONFIG = '/etc/rclone/rclone.conf';
function uploadToDrive(filePath) {
  execFile('rclone', ['--config', RCLONE_CONFIG, 'copy', filePath, RCLONE_REMOTE], (err, stdout, stderr) => {
    if (err) console.error('rclone upload failed for', filePath, '-', stderr || err.message);
    else console.log('Uploaded to Google Drive:', path.basename(filePath));
  });
}
function runBackup() {
  const file = path.join(BACKUP_DIR, backupFileName(new Date()));
  try {
    db.prepare('VACUUM INTO ?').run(file);
    console.log('Backup created:', path.basename(file));
    pruneOldBackups();
    uploadToDrive(file);
  } catch (err) {
    console.error('Backup failed:', err.message);
  }
}
function scheduleBackups() {
  let lastRunKey = '';
  setInterval(() => {
    const now = new Date();
    if (now.getMinutes() !== 0 || !BACKUP_HOURS.includes(now.getHours())) return;
    const key = now.toISOString().slice(0, 13); // one run per hour-slot
    if (key === lastRunKey) return;
    lastRunKey = key;
    runBackup();
  }, 30 * 1000);
}
scheduleBackups();

// ---------- password / sessions ----------
function sha256(text) { return crypto.createHash('sha256').update(text, 'utf8').digest('hex'); }
function randomToken() { return crypto.randomBytes(24).toString('hex'); }

const sessions = new Map(); // token -> {username, role, expires}

function pruneSessions() {
  const now = Date.now();
  for (const [token, s] of sessions) if (s.expires < now) sessions.delete(token);
}

function requireAuth(req, res, next) {
  const token = req.get('X-Auth-Token') || req.query.token;
  pruneSessions();
  const session = token && sessions.get(token);
  if (!session) return res.status(401).json({ ok: false, error: 'not_authenticated' });
  req.session = session;
  next();
}
function requireWrite(req, res, next) {
  if (req.session.role !== 'admin' && req.session.role !== 'planning') {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  next();
}
function requireAdmin(req, res, next) {
  if (req.session.role !== 'admin') return res.status(403).json({ ok: false, error: 'forbidden' });
  next();
}

// ---------- seed an initial admin if the users table is empty ----------
// Never reuses a fixed password — prints a one-time random one to the
// server's own console/log on first boot, for you (the operator) to read
// with `journalctl` and then change from the Admin tab.
(function seedAdminIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return;
  const username = process.env.SEED_ADMIN_USER || 'Pelichet';
  const password = process.env.SEED_ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = sha256(salt + password);
  db.prepare('INSERT INTO users (username, salt, hash, role) VALUES (?, ?, ?, ?)').run(username, salt, hash, 'admin');
  console.log('=============================================');
  console.log('First run: created admin account');
  console.log('  username:', username);
  console.log('  password:', password);
  console.log('Change it from the Admin tab after logging in.');
  console.log('=============================================');
})();

// ---------- seed employees/vehicles from the original Excel data ----------
(function seedDataIfEmpty() {
  const empCount = db.prepare('SELECT COUNT(*) AS n FROM employees').get().n;
  const vehCount = db.prepare('SELECT COUNT(*) AS n FROM vehicles').get().n;
  if (empCount > 0 || vehCount > 0) return;
  try {
    const seed = JSON.parse(require('fs').readFileSync(path.join(__dirname, 'seed-data.json'), 'utf8'));
    const insertEmp = db.prepare('INSERT INTO employees (id, company, name, active, "order") VALUES (?, ?, ?, ?, ?)');
    const insertVeh = db.prepare('INSERT INTO vehicles (id, name, active, "order") VALUES (?, ?, ?, ?)');
    const tx = db.transaction(() => {
      (seed.employees || []).forEach(e => insertEmp.run(e.id, e.company, e.name, e.active === false ? 0 : 1, e.order || 0));
      (seed.vehicles || []).forEach(v => insertVeh.run(v.id, v.name, v.active === false ? 0 : 1, v.order || 0));
    });
    tx();
    console.log(`Seeded ${seed.employees.length} employees and ${seed.vehicles.length} vehicles from seed-data.json`);
  } catch (err) {
    console.log('No seed-data.json found or failed to load — starting with empty employees/vehicles.', err.message);
  }
})();

// ---------- SSE (push updates to every connected browser) ----------
const sseClients = new Set();
function broadcast() {
  for (const res of sseClients) res.write('data: changed\n\n');
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/events', requireAuth, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ---------- auth ----------
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username || '');
  if (!user || sha256(user.salt + (password || '')) !== user.hash) {
    return res.json({ ok: false, error: 'invalid_credentials' });
  }
  const token = randomToken();
  sessions.set(token, { username: user.username, role: user.role, expires: Date.now() + SESSION_TTL_MS });
  res.json({ ok: true, token, username: user.username, role: user.role });
});

// ---------- data ----------
function rowToEmployee(r) { return { id: r.id, company: r.company, name: r.name, active: !!r.active, order: r.order }; }
function rowToVehicle(r) { return { id: r.id, name: r.name, active: !!r.active, order: r.order, type: r.type || '', capacity: r.capacity || '' }; }
function rowToDossier(r) {
  return {
    id: r.id, client: r.client, dossierNumber: r.dossierNumber || '', startDate: r.startDate, endDate: r.endDate,
    addressFrom: r.addressFrom, addressTo: r.addressTo, volume: r.volume,
    seller: r.seller, coordinator: r.coordinator, task: r.task, comment: r.comment || '', moveType: r.moveType,
    createdAt: r.createdAt, displayOrder: r.displayOrder || 0,
    sameResourcesAllDays: !!r.sameResourcesAllDays
  };
}
function rowToAssignment(r) {
  return {
    id: r.id, dossierId: r.dossierId, date: r.date,
    employees: JSON.parse(r.employeesJson || '[]'),
    vehicleIds: JSON.parse(r.vehicleIdsJson || '[]'),
    arrivalTime: r.arrivalTime, slot: r.slot
  };
}
function rowToAbsence(r) { return { id: r.id, employeeId: r.employeeId, reason: r.reason, startDate: r.startDate, endDate: r.endDate }; }
function rowToVehicleDowntime(r) { return { id: r.id, vehicleId: r.vehicleId, reason: r.reason, startDate: r.startDate, endDate: r.endDate }; }
function rowToHistory(r) { return { id: r.id, dossierId: r.dossierId, field: r.field, oldValue: r.oldValue || '', newValue: r.newValue || '', changedBy: r.changedBy || '', changedAt: r.changedAt }; }

// Fields tracked in the dossier change history — labels live client-side.
const DOSSIER_HISTORY_FIELDS = [
  'client', 'dossierNumber', 'startDate', 'endDate', 'addressFrom', 'addressTo',
  'volume', 'seller', 'coordinator', 'task', 'comment', 'moveType'
];
function recordDossierHistory(oldRow, newValues, changedBy) {
  const changes = DOSSIER_HISTORY_FIELDS
    .map(field => ({ field, oldValue: (oldRow ? oldRow[field] : '') || '', newValue: newValues[field] || '' }))
    .filter(c => c.oldValue !== c.newValue);
  if (!changes.length) return;
  const insert = db.prepare(`
    INSERT INTO dossier_history (id, dossierId, field, oldValue, newValue, changedBy, changedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const now = Date.now();
  const tx = db.transaction(() => {
    changes.forEach(c => insert.run(crypto.randomUUID(), newValues.id, c.field, c.oldValue, c.newValue, changedBy, now));
  });
  tx();
}

app.get('/api/all', requireAuth, (req, res) => {
  res.json({
    ok: true,
    role: req.session.role,
    username: req.session.username,
    employees: db.prepare('SELECT * FROM employees').all().map(rowToEmployee),
    vehicles: db.prepare('SELECT * FROM vehicles').all().map(rowToVehicle),
    dossiers: db.prepare('SELECT * FROM dossiers').all().map(rowToDossier),
    assignments: db.prepare('SELECT * FROM assignments').all().map(rowToAssignment),
    absences: db.prepare('SELECT * FROM absences').all().map(rowToAbsence),
    vehicleDowntimes: db.prepare('SELECT * FROM vehicle_downtimes').all().map(rowToVehicleDowntime),
    settings: Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(r => [r.key, r.value]))
  });
});

app.post('/api/settings', requireAuth, requireWrite, (req, res) => {
  const values = req.body.values || {};
  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  const tx = db.transaction(() => { Object.keys(values).forEach(k => upsert.run(k, String(values[k]))); });
  tx();
  broadcast();
  res.json({ ok: true });
});

app.post('/api/employees', requireAuth, requireWrite, (req, res) => {
  const e = req.body.item || {};
  if (!e.id || !e.name || !e.company) return res.status(400).json({ ok: false, error: 'bad_request' });
  db.prepare(`
    INSERT INTO employees (id, company, name, active, "order") VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET company=excluded.company, name=excluded.name, active=excluded.active, "order"=excluded."order"
  `).run(e.id, e.company, e.name, e.active === false ? 0 : 1, e.order || 0);
  broadcast();
  res.json({ ok: true });
});
app.delete('/api/employees/:id', requireAuth, requireWrite, (req, res) => {
  db.prepare('DELETE FROM employees WHERE id = ?').run(req.params.id);
  broadcast();
  res.json({ ok: true });
});

app.post('/api/vehicles', requireAuth, requireWrite, (req, res) => {
  const v = req.body.item || {};
  if (!v.id || !v.name) return res.status(400).json({ ok: false, error: 'bad_request' });
  db.prepare(`
    INSERT INTO vehicles (id, name, active, "order", type, capacity) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, active=excluded.active, "order"=excluded."order", type=excluded.type, capacity=excluded.capacity
  `).run(v.id, v.name, v.active === false ? 0 : 1, v.order || 0, v.type || '', v.capacity || '');
  broadcast();
  res.json({ ok: true });
});
app.delete('/api/vehicles/:id', requireAuth, requireWrite, (req, res) => {
  db.prepare('DELETE FROM vehicles WHERE id = ?').run(req.params.id);
  broadcast();
  res.json({ ok: true });
});

app.post('/api/dossiers', requireAuth, requireWrite, (req, res) => {
  const d = req.body.item || {};
  if (!d.id || !d.startDate || !d.endDate) return res.status(400).json({ ok: false, error: 'bad_request' });
  const oldRow = db.prepare('SELECT * FROM dossiers WHERE id = ?').get(d.id);
  db.prepare(`
    INSERT INTO dossiers (id, client, dossierNumber, startDate, endDate, addressFrom, addressTo, volume, seller, coordinator, task, comment, moveType, createdAt, displayOrder, sameResourcesAllDays)
    VALUES (@id, @client, @dossierNumber, @startDate, @endDate, @addressFrom, @addressTo, @volume, @seller, @coordinator, @task, @comment, @moveType, @createdAt, @displayOrder, @sameResourcesAllDays)
    ON CONFLICT(id) DO UPDATE SET
      client=excluded.client, dossierNumber=excluded.dossierNumber, startDate=excluded.startDate, endDate=excluded.endDate,
      addressFrom=excluded.addressFrom, addressTo=excluded.addressTo, volume=excluded.volume,
      seller=excluded.seller, coordinator=excluded.coordinator, task=excluded.task, comment=excluded.comment, moveType=excluded.moveType,
      displayOrder=excluded.displayOrder, sameResourcesAllDays=excluded.sameResourcesAllDays
  `).run({
    id: d.id, client: d.client || '', dossierNumber: d.dossierNumber || '', startDate: d.startDate, endDate: d.endDate,
    addressFrom: d.addressFrom || '', addressTo: d.addressTo || '', volume: d.volume || '',
    seller: d.seller || '', coordinator: d.coordinator || '', task: d.task || '', comment: d.comment || '', moveType: d.moveType || '',
    createdAt: d.createdAt || Date.now(), displayOrder: d.displayOrder || 0,
    sameResourcesAllDays: d.sameResourcesAllDays ? 1 : 0
  });
  recordDossierHistory(oldRow, d, req.session.username);
  broadcast();
  res.json({ ok: true });
});
app.delete('/api/dossiers/:id', requireAuth, requireWrite, (req, res) => {
  const tx = db.transaction((id) => {
    db.prepare('DELETE FROM dossiers WHERE id = ?').run(id);
    db.prepare('DELETE FROM assignments WHERE dossierId = ?').run(id);
    db.prepare('DELETE FROM dossier_history WHERE dossierId = ?').run(id);
  });
  tx(req.params.id);
  broadcast();
  res.json({ ok: true });
});
app.get('/api/dossiers/:id/history', requireAuth, (req, res) => {
  res.json({
    ok: true,
    history: db.prepare('SELECT * FROM dossier_history WHERE dossierId = ? ORDER BY changedAt DESC').all(req.params.id).map(rowToHistory)
  });
});

app.post('/api/assignments', requireAuth, requireWrite, (req, res) => {
  const a = req.body.item || {};
  if (!a.id || !a.dossierId || !a.date) return res.status(400).json({ ok: false, error: 'bad_request' });
  db.prepare(`
    INSERT INTO assignments (id, dossierId, date, employeesJson, vehicleIdsJson, arrivalTime, slot)
    VALUES (@id, @dossierId, @date, @employeesJson, @vehicleIdsJson, @arrivalTime, @slot)
    ON CONFLICT(id) DO UPDATE SET
      employeesJson=excluded.employeesJson, vehicleIdsJson=excluded.vehicleIdsJson,
      arrivalTime=excluded.arrivalTime, slot=excluded.slot
  `).run({
    id: a.id, dossierId: a.dossierId, date: a.date,
    employeesJson: JSON.stringify(a.employees || []),
    vehicleIdsJson: JSON.stringify(a.vehicleIds || []),
    arrivalTime: a.arrivalTime || '', slot: a.slot || ''
  });
  broadcast();
  res.json({ ok: true });
});

app.post('/api/absences', requireAuth, requireWrite, (req, res) => {
  const a = req.body.item || {};
  if (!a.id || !a.employeeId || !a.reason || !a.startDate || !a.endDate) return res.status(400).json({ ok: false, error: 'bad_request' });
  db.prepare(`
    INSERT INTO absences (id, employeeId, reason, startDate, endDate) VALUES (@id, @employeeId, @reason, @startDate, @endDate)
    ON CONFLICT(id) DO UPDATE SET employeeId=excluded.employeeId, reason=excluded.reason, startDate=excluded.startDate, endDate=excluded.endDate
  `).run({ id: a.id, employeeId: a.employeeId, reason: a.reason, startDate: a.startDate, endDate: a.endDate });
  broadcast();
  res.json({ ok: true });
});
app.delete('/api/absences/:id', requireAuth, requireWrite, (req, res) => {
  db.prepare('DELETE FROM absences WHERE id = ?').run(req.params.id);
  broadcast();
  res.json({ ok: true });
});

app.post('/api/vehicle-downtimes', requireAuth, requireWrite, (req, res) => {
  const v = req.body.item || {};
  if (!v.id || !v.vehicleId || !v.reason || !v.startDate || !v.endDate) return res.status(400).json({ ok: false, error: 'bad_request' });
  db.prepare(`
    INSERT INTO vehicle_downtimes (id, vehicleId, reason, startDate, endDate) VALUES (@id, @vehicleId, @reason, @startDate, @endDate)
    ON CONFLICT(id) DO UPDATE SET vehicleId=excluded.vehicleId, reason=excluded.reason, startDate=excluded.startDate, endDate=excluded.endDate
  `).run({ id: v.id, vehicleId: v.vehicleId, reason: v.reason, startDate: v.startDate, endDate: v.endDate });
  broadcast();
  res.json({ ok: true });
});
app.delete('/api/vehicle-downtimes/:id', requireAuth, requireWrite, (req, res) => {
  db.prepare('DELETE FROM vehicle_downtimes WHERE id = ?').run(req.params.id);
  broadcast();
  res.json({ ok: true });
});

// ---------- admin: user accounts ----------
app.get('/api/users', requireAuth, requireAdmin, (req, res) => {
  res.json({ ok: true, users: db.prepare('SELECT username, role FROM users').all() });
});
app.post('/api/users', requireAuth, requireAdmin, (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password || !['admin', 'planning', 'user'].includes(role)) {
    return res.status(400).json({ ok: false, error: 'bad_request' });
  }
  const exists = db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
  if (exists) return res.json({ ok: false, error: 'username_taken' });
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = sha256(salt + password);
  db.prepare('INSERT INTO users (username, salt, hash, role) VALUES (?, ?, ?, ?)').run(username, salt, hash, role);
  res.json({ ok: true });
});
app.post('/api/users/:username/reset-password', requireAuth, requireAdmin, (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 4) return res.status(400).json({ ok: false, error: 'bad_request' });
  const exists = db.prepare('SELECT 1 FROM users WHERE username = ?').get(req.params.username);
  if (!exists) return res.json({ ok: false, error: 'not_found' });
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = sha256(salt + password);
  db.prepare('UPDATE users SET salt = ?, hash = ? WHERE username = ?').run(salt, hash, req.params.username);
  res.json({ ok: true });
});
app.delete('/api/users/:username', requireAuth, requireAdmin, (req, res) => {
  if (req.params.username === req.session.username) return res.json({ ok: false, error: 'cannot_delete_self' });
  db.prepare('DELETE FROM users WHERE username = ?').run(req.params.username);
  res.json({ ok: true });
});

// ---------- backups API (admin only) ----------
const BACKUP_FILENAME_RE = /^planning-[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}h[0-9]{2}\.db$|^avant-restauration-[0-9-]+\.db$/;

app.get('/api/backups', requireAuth, requireAdmin, (req, res) => {
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => BACKUP_FILENAME_RE.test(f))
    .map(f => {
      const st = fs.statSync(path.join(BACKUP_DIR, f));
      return { name: f, size: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  res.json({ ok: true, files, retentionDays: BACKUP_RETENTION_DAYS });
});

app.get('/api/backups/:name/download', requireAuth, requireAdmin, (req, res) => {
  if (!BACKUP_FILENAME_RE.test(req.params.name)) return res.status(400).json({ ok: false, error: 'bad_request' });
  const full = path.join(BACKUP_DIR, req.params.name);
  if (!fs.existsSync(full)) return res.status(404).json({ ok: false, error: 'not_found' });
  res.download(full);
});

app.post('/api/backups/run', requireAuth, requireAdmin, (req, res) => {
  runBackup();
  res.json({ ok: true });
});

app.post('/api/backups/restore', requireAuth, requireAdmin, express.raw({ type: 'application/octet-stream', limit: '200mb' }), (req, res) => {
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length < 16 || buf.toString('utf8', 0, 15) !== 'SQLite format 3') {
    return res.status(400).json({ ok: false, error: 'not_a_sqlite_file' });
  }
  fs.writeFileSync(RESTORE_PENDING_PATH, buf);
  res.json({ ok: true, message: 'Fichier reçu, redémarrage du serveur pour appliquer la restauration…' });
  setTimeout(() => { db.close(); process.exit(0); }, 300);
});

app.listen(PORT, () => console.log('Planning Effectifs listening on port ' + PORT));
