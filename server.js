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
// Overridable so the automated test suite can point at a disposable
// directory instead of touching real dev/production data.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
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
  CREATE TABLE IF NOT EXISTS action_log (
    id TEXT PRIMARY KEY,
    entityType TEXT NOT NULL,
    entityId TEXT NOT NULL,
    action TEXT NOT NULL,
    beforeJson TEXT,
    afterJson TEXT,
    performedBy TEXT DEFAULT '',
    performedAt INTEGER NOT NULL,
    undone INTEGER NOT NULL DEFAULT 0,
    undoneAt INTEGER
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
  if (!cols.includes('workWeekends')) {
    db.exec("ALTER TABLE dossiers ADD COLUMN workWeekends INTEGER NOT NULL DEFAULT 0");
  }
  ['plannedEmployees', 'plannedFourgon', 'plannedPL', 'plannedVL'].forEach((col) => {
    if (!cols.includes(col)) {
      db.exec(`ALTER TABLE dossiers ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`);
    }
  });
})();
(function migrateEmployeeDeleted() {
  const cols = db.prepare("PRAGMA table_info(employees)").all().map(c => c.name);
  if (!cols.includes('deleted')) {
    db.exec("ALTER TABLE employees ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0");
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
// Recorded in the settings table (same key/value store the frontend already
// polls via /api/all) so a silent, unattended rclone failure — an expired
// Drive auth token, a network blip that never recovers — shows up in the
// Admin tab instead of only ever reaching a log file nobody is watching.
function recordDriveSyncStatus(ok, error) {
  const value = JSON.stringify({ ok, at: Date.now(), error: error ? String(error).slice(0, 300) : undefined });
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run('driveSyncStatus', value);
  broadcast();
}
function uploadToDrive(filePath) {
  execFile('rclone', ['--config', RCLONE_CONFIG, 'copy', filePath, RCLONE_REMOTE], (err, stdout, stderr) => {
    if (err) {
      console.error('rclone upload failed for', filePath, '-', stderr || err.message);
      recordDriveSyncStatus(false, stderr || err.message);
    } else {
      console.log('Uploaded to Google Drive:', path.basename(filePath));
      recordDriveSyncStatus(true);
    }
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
// Passwords are hashed with scrypt (salted, deliberately slow — unlike a
// single SHA-256 pass, which a GPU can brute-force at billions/sec if the
// database ever leaks). Old accounts created before this still have a bare
// hex SHA-256 hash in `hash`; verifyPassword() recognizes both, and a
// successful login against an old hash immediately re-hashes it with
// scrypt (see /api/login) — a lazy migration with no forced reset needed.
function sha256(text) { return crypto.createHash('sha256').update(text, 'utf8').digest('hex'); }
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = 'scrypt:' + crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, storedHash) {
  if (storedHash.startsWith('scrypt:')) {
    const expected = Buffer.from(storedHash.slice(7), 'hex');
    const actual = crypto.scryptSync(password, salt, expected.length);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }
  const expected = Buffer.from(storedHash, 'hex');
  const actual = Buffer.from(sha256(salt + password), 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
function randomToken() { return crypto.randomBytes(24).toString('hex'); }

// ---------- login rate limiting ----------
// Two independent buckets per failed attempt: one keyed by username (slows
// down guessing one specific account's password, from any/many IPs) and one
// keyed by source IP (slows down one source hammering the endpoint at all,
// regardless of which account it's trying). In-memory only, like `sessions`
// below — fine for a single-process app, and resets on restart same as
// everything else here.
const rateLimitBuckets = new Map(); // "kind:key" -> {count, lockedUntil, lastAttemptAt}
const LOGIN_USER_MAX_ATTEMPTS = 5, LOGIN_USER_LOCKOUT_MS = 5 * 60 * 1000;
const LOGIN_IP_MAX_ATTEMPTS = 20, LOGIN_IP_LOCKOUT_MS = 10 * 60 * 1000;
const RATE_LIMIT_FORGET_MS = 15 * 60 * 1000; // drop stale entries so probing many fake usernames/IPs can't grow this forever
function rateLimitKey(kind, key) { return kind + ':' + String(key || '').toLowerCase(); }
function pruneRateLimits() {
  const now = Date.now();
  for (const [k, entry] of rateLimitBuckets) {
    if (entry.lockedUntil < now && now - entry.lastAttemptAt > RATE_LIMIT_FORGET_MS) rateLimitBuckets.delete(k);
  }
}
function isRateLimited(kind, key) {
  pruneRateLimits();
  const entry = rateLimitBuckets.get(rateLimitKey(kind, key));
  return !!(entry && entry.lockedUntil > Date.now());
}
function recordRateLimitFailure(kind, key, maxAttempts, lockoutMs) {
  const k = rateLimitKey(kind, key);
  const now = Date.now();
  const entry = rateLimitBuckets.get(k) || { count: 0, lockedUntil: 0, lastAttemptAt: now };
  entry.count += 1;
  entry.lastAttemptAt = now;
  if (entry.count >= maxAttempts) {
    entry.lockedUntil = now + lockoutMs;
    entry.count = 0;
  }
  rateLimitBuckets.set(k, entry);
}
function clearRateLimit(kind, key) {
  rateLimitBuckets.delete(rateLimitKey(kind, key));
}

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
  const { salt, hash } = hashPassword(password);
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
// Exactly one reverse proxy in front in production (Nginx Proxy Manager —
// see README), so req.ip resolves to the real client IP from the single
// X-Forwarded-For hop it adds, instead of always reporting the proxy's own
// Docker-gateway address for every visitor.
app.set('trust proxy', 1);
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
  if (isRateLimited('user', username) || isRateLimited('ip', req.ip)) {
    return res.json({ ok: false, error: 'too_many_attempts' });
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username || '');
  if (!user || !verifyPassword(password || '', user.salt, user.hash)) {
    recordRateLimitFailure('user', username, LOGIN_USER_MAX_ATTEMPTS, LOGIN_USER_LOCKOUT_MS);
    recordRateLimitFailure('ip', req.ip, LOGIN_IP_MAX_ATTEMPTS, LOGIN_IP_LOCKOUT_MS);
    return res.json({ ok: false, error: 'invalid_credentials' });
  }
  clearRateLimit('user', username);
  if (!user.hash.startsWith('scrypt:')) {
    const { salt, hash } = hashPassword(password);
    db.prepare('UPDATE users SET salt = ?, hash = ? WHERE username = ?').run(salt, hash, user.username);
  }
  const token = randomToken();
  sessions.set(token, { username: user.username, role: user.role, expires: Date.now() + SESSION_TTL_MS });
  res.json({ ok: true, token, username: user.username, role: user.role });
});

// ---------- data ----------
function rowToEmployee(r) { return { id: r.id, company: r.company, name: r.name, active: !!r.active, order: r.order, deleted: !!r.deleted }; }
function rowToVehicle(r) { return { id: r.id, name: r.name, active: !!r.active, order: r.order, type: r.type || '', capacity: r.capacity || '' }; }
function rowToDossier(r) {
  return {
    id: r.id, client: r.client, dossierNumber: r.dossierNumber || '', startDate: r.startDate, endDate: r.endDate,
    addressFrom: r.addressFrom, addressTo: r.addressTo, volume: r.volume,
    seller: r.seller, coordinator: r.coordinator, task: r.task, comment: r.comment || '', moveType: r.moveType,
    createdAt: r.createdAt, displayOrder: r.displayOrder || 0,
    sameResourcesAllDays: !!r.sameResourcesAllDays, workWeekends: !!r.workWeekends,
    plannedEmployees: r.plannedEmployees || 0, plannedFourgon: r.plannedFourgon || 0,
    plannedPL: r.plannedPL || 0, plannedVL: r.plannedVL || 0
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

// Dossiers (and their assignments) that ended more than this long ago are
// left out of the main payload — every screen only ever looks at the
// current/near-future window, so there's no reason to keep re-sending years
// of closed jobsites on every load as the database grows. They're never
// deleted, just not in the hot path; /api/dossiers/archive looks them up
// on demand (Admin tab).
const ARCHIVE_CUTOFF_MONTHS = 18;
function archiveCutoffDate() {
  const d = new Date();
  d.setMonth(d.getMonth() - ARCHIVE_CUTOFF_MONTHS);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
app.get('/api/all', requireAuth, (req, res) => {
  const cutoff = archiveCutoffDate();
  res.json({
    ok: true,
    role: req.session.role,
    username: req.session.username,
    employees: db.prepare('SELECT * FROM employees').all().map(rowToEmployee),
    vehicles: db.prepare('SELECT * FROM vehicles').all().map(rowToVehicle),
    dossiers: db.prepare('SELECT * FROM dossiers WHERE endDate >= ?').all(cutoff).map(rowToDossier),
    assignments: db.prepare(`
      SELECT a.* FROM assignments a JOIN dossiers d ON d.id = a.dossierId WHERE d.endDate >= ?
    `).all(cutoff).map(rowToAssignment),
    absences: db.prepare('SELECT * FROM absences').all().map(rowToAbsence),
    vehicleDowntimes: db.prepare('SELECT * FROM vehicle_downtimes').all().map(rowToVehicleDowntime),
    settings: Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(r => [r.key, r.value]))
  });
});

const ARCHIVE_SEARCH_LIMIT = 100;
app.get('/api/dossiers/archive', requireAuth, (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ ok: true, dossiers: [], assignmentsByDossier: {} });
  const cutoff = archiveCutoffDate();
  const like = '%' + q + '%';
  const dossiers = db.prepare(`
    SELECT * FROM dossiers
    WHERE endDate < ?
      AND (client LIKE ? COLLATE NOCASE OR dossierNumber LIKE ? COLLATE NOCASE
           OR addressFrom LIKE ? COLLATE NOCASE OR addressTo LIKE ? COLLATE NOCASE)
    ORDER BY endDate DESC
    LIMIT ?
  `).all(cutoff, like, like, like, like, ARCHIVE_SEARCH_LIMIT).map(rowToDossier);
  const assignmentsByDossier = {};
  if (dossiers.length) {
    const placeholders = dossiers.map(() => '?').join(',');
    db.prepare(`SELECT * FROM assignments WHERE dossierId IN (${placeholders})`)
      .all(...dossiers.map(d => d.id)).map(rowToAssignment)
      .forEach(a => { (assignmentsByDossier[a.dossierId] = assignmentsByDossier[a.dossierId] || []).push(a); });
  }
  res.json({ ok: true, dossiers, assignmentsByDossier });
});

app.post('/api/settings', requireAuth, requireWrite, (req, res) => {
  const values = req.body.values || {};
  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  const tx = db.transaction(() => { Object.keys(values).forEach(k => upsert.run(k, String(values[k]))); });
  tx();
  broadcast();
  res.json({ ok: true });
});

// ---------- generic action log (undo) ----------
// Every create/update/delete on the entities below is logged with a full
// before/after row snapshot, so the last N actions can be shown — and
// reversed — from any tab, regardless of which screen made the change.
// Settings and user accounts are deliberately not included: bulk key/value
// changes and account security aren't a good fit for a single-click undo.
const ACTION_LOG_LIMIT = 200;
function recordAction(entityType, entityId, action, before, after, performedBy) {
  if (JSON.stringify(before || null) === JSON.stringify(after || null)) return; // no actual change
  db.prepare(`
    INSERT INTO action_log (id, entityType, entityId, action, beforeJson, afterJson, performedBy, performedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), entityType, entityId, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, performedBy || '', Date.now());
  db.prepare('DELETE FROM action_log WHERE id NOT IN (SELECT id FROM action_log ORDER BY performedAt DESC LIMIT ?)').run(ACTION_LOG_LIMIT);
}

function saveEmployeeRow(e) {
  db.prepare(`
    INSERT INTO employees (id, company, name, active, "order", deleted) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET company=excluded.company, name=excluded.name, active=excluded.active, "order"=excluded."order", deleted=excluded.deleted
  `).run(e.id, e.company, e.name, e.active === false ? 0 : 1, e.order || 0, e.deleted ? 1 : 0);
}
function removeEmployeeRow(id) { db.prepare('DELETE FROM employees WHERE id = ?').run(id); }

function saveVehicleRow(v) {
  db.prepare(`
    INSERT INTO vehicles (id, name, active, "order", type, capacity) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, active=excluded.active, "order"=excluded."order", type=excluded.type, capacity=excluded.capacity
  `).run(v.id, v.name, v.active === false ? 0 : 1, v.order || 0, v.type || '', v.capacity || '');
}
function removeVehicleRow(id) { db.prepare('DELETE FROM vehicles WHERE id = ?').run(id); }

function saveDossierRow(d) {
  db.prepare(`
    INSERT INTO dossiers (id, client, dossierNumber, startDate, endDate, addressFrom, addressTo, volume, seller, coordinator, task, comment, moveType, createdAt, displayOrder, sameResourcesAllDays, workWeekends, plannedEmployees, plannedFourgon, plannedPL, plannedVL)
    VALUES (@id, @client, @dossierNumber, @startDate, @endDate, @addressFrom, @addressTo, @volume, @seller, @coordinator, @task, @comment, @moveType, @createdAt, @displayOrder, @sameResourcesAllDays, @workWeekends, @plannedEmployees, @plannedFourgon, @plannedPL, @plannedVL)
    ON CONFLICT(id) DO UPDATE SET
      client=excluded.client, dossierNumber=excluded.dossierNumber, startDate=excluded.startDate, endDate=excluded.endDate,
      addressFrom=excluded.addressFrom, addressTo=excluded.addressTo, volume=excluded.volume,
      seller=excluded.seller, coordinator=excluded.coordinator, task=excluded.task, comment=excluded.comment, moveType=excluded.moveType,
      displayOrder=excluded.displayOrder, sameResourcesAllDays=excluded.sameResourcesAllDays, workWeekends=excluded.workWeekends,
      plannedEmployees=excluded.plannedEmployees, plannedFourgon=excluded.plannedFourgon, plannedPL=excluded.plannedPL, plannedVL=excluded.plannedVL
  `).run({
    id: d.id, client: d.client || '', dossierNumber: d.dossierNumber || '', startDate: d.startDate, endDate: d.endDate,
    addressFrom: d.addressFrom || '', addressTo: d.addressTo || '', volume: d.volume || '',
    seller: d.seller || '', coordinator: d.coordinator || '', task: d.task || '', comment: d.comment || '', moveType: d.moveType || '',
    createdAt: d.createdAt || Date.now(), displayOrder: d.displayOrder || 0,
    sameResourcesAllDays: d.sameResourcesAllDays ? 1 : 0, workWeekends: d.workWeekends ? 1 : 0,
    plannedEmployees: d.plannedEmployees || 0, plannedFourgon: d.plannedFourgon || 0,
    plannedPL: d.plannedPL || 0, plannedVL: d.plannedVL || 0
  });
}
function removeDossierRow(id) {
  const tx = db.transaction((id) => {
    db.prepare('DELETE FROM dossiers WHERE id = ?').run(id);
    db.prepare('DELETE FROM assignments WHERE dossierId = ?').run(id);
    db.prepare('DELETE FROM dossier_history WHERE dossierId = ?').run(id);
  });
  tx(id);
}

function saveAssignmentRow(a) {
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
}
function removeAssignmentRow(id) { db.prepare('DELETE FROM assignments WHERE id = ?').run(id); }

function saveAbsenceRow(a) {
  db.prepare(`
    INSERT INTO absences (id, employeeId, reason, startDate, endDate) VALUES (@id, @employeeId, @reason, @startDate, @endDate)
    ON CONFLICT(id) DO UPDATE SET employeeId=excluded.employeeId, reason=excluded.reason, startDate=excluded.startDate, endDate=excluded.endDate
  `).run({ id: a.id, employeeId: a.employeeId, reason: a.reason, startDate: a.startDate, endDate: a.endDate });
}
function removeAbsenceRow(id) { db.prepare('DELETE FROM absences WHERE id = ?').run(id); }

function saveDowntimeRow(v) {
  db.prepare(`
    INSERT INTO vehicle_downtimes (id, vehicleId, reason, startDate, endDate) VALUES (@id, @vehicleId, @reason, @startDate, @endDate)
    ON CONFLICT(id) DO UPDATE SET vehicleId=excluded.vehicleId, reason=excluded.reason, startDate=excluded.startDate, endDate=excluded.endDate
  `).run({ id: v.id, vehicleId: v.vehicleId, reason: v.reason, startDate: v.startDate, endDate: v.endDate });
}
function removeDowntimeRow(id) { db.prepare('DELETE FROM vehicle_downtimes WHERE id = ?').run(id); }

const ENTITIES = {
  employee: { table: 'employees', getRow: id => db.prepare('SELECT * FROM employees WHERE id = ?').get(id), rowTo: rowToEmployee, save: saveEmployeeRow, remove: removeEmployeeRow },
  vehicle: { table: 'vehicles', getRow: id => db.prepare('SELECT * FROM vehicles WHERE id = ?').get(id), rowTo: rowToVehicle, save: saveVehicleRow, remove: removeVehicleRow },
  dossier: { table: 'dossiers', getRow: id => db.prepare('SELECT * FROM dossiers WHERE id = ?').get(id), rowTo: rowToDossier, save: saveDossierRow, remove: removeDossierRow },
  assignment: { table: 'assignments', getRow: id => db.prepare('SELECT * FROM assignments WHERE id = ?').get(id), rowTo: rowToAssignment, save: saveAssignmentRow, remove: removeAssignmentRow },
  absence: { table: 'absences', getRow: id => db.prepare('SELECT * FROM absences WHERE id = ?').get(id), rowTo: rowToAbsence, save: saveAbsenceRow, remove: removeAbsenceRow },
  downtime: { table: 'vehicle_downtimes', getRow: id => db.prepare('SELECT * FROM vehicle_downtimes WHERE id = ?').get(id), rowTo: rowToVehicleDowntime, save: saveDowntimeRow, remove: removeDowntimeRow }
};

function rowToActionLog(r) {
  return {
    id: r.id, entityType: r.entityType, entityId: r.entityId, action: r.action,
    before: r.beforeJson ? JSON.parse(r.beforeJson) : null, after: r.afterJson ? JSON.parse(r.afterJson) : null,
    performedBy: r.performedBy || '', performedAt: r.performedAt, undone: !!r.undone
  };
}
app.get('/api/action-log', requireAuth, (req, res) => {
  const limit = Math.min(ACTION_LOG_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || 10));
  res.json({ ok: true, actions: db.prepare('SELECT * FROM action_log ORDER BY performedAt DESC LIMIT ?').all(limit).map(rowToActionLog) });
});
app.post('/api/action-log/:id/undo', requireAuth, requireWrite, (req, res) => {
  const row = db.prepare('SELECT * FROM action_log WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
  if (row.undone) return res.json({ ok: false, error: 'already_undone' });
  const entity = ENTITIES[row.entityType];
  if (!entity) return res.status(400).json({ ok: false, error: 'unknown_entity' });
  if (row.action === 'create') {
    entity.remove(row.entityId);
  } else {
    if (!row.beforeJson) return res.status(400).json({ ok: false, error: 'nothing_to_restore' });
    entity.save(entity.rowTo(JSON.parse(row.beforeJson)));
  }
  db.prepare('UPDATE action_log SET undone = 1, undoneAt = ? WHERE id = ?').run(Date.now(), row.id);
  broadcast();
  res.json({ ok: true });
});

app.post('/api/employees', requireAuth, requireWrite, (req, res) => {
  const e = req.body.item || {};
  if (!e.id || !e.name || !e.company) return res.status(400).json({ ok: false, error: 'bad_request' });
  const before = ENTITIES.employee.getRow(e.id);
  saveEmployeeRow(e);
  recordAction('employee', e.id, before ? 'update' : 'create', before, ENTITIES.employee.getRow(e.id), req.session.username);
  broadcast();
  res.json({ ok: true });
});
app.delete('/api/employees/:id', requireAuth, requireWrite, (req, res) => {
  const before = ENTITIES.employee.getRow(req.params.id);
  removeEmployeeRow(req.params.id);
  if (before) recordAction('employee', req.params.id, 'delete', before, null, req.session.username);
  broadcast();
  res.json({ ok: true });
});

app.post('/api/vehicles', requireAuth, requireWrite, (req, res) => {
  const v = req.body.item || {};
  if (!v.id || !v.name) return res.status(400).json({ ok: false, error: 'bad_request' });
  const before = ENTITIES.vehicle.getRow(v.id);
  saveVehicleRow(v);
  recordAction('vehicle', v.id, before ? 'update' : 'create', before, ENTITIES.vehicle.getRow(v.id), req.session.username);
  broadcast();
  res.json({ ok: true });
});
app.delete('/api/vehicles/:id', requireAuth, requireWrite, (req, res) => {
  const before = ENTITIES.vehicle.getRow(req.params.id);
  removeVehicleRow(req.params.id);
  if (before) recordAction('vehicle', req.params.id, 'delete', before, null, req.session.username);
  broadcast();
  res.json({ ok: true });
});

app.post('/api/dossiers', requireAuth, requireWrite, (req, res) => {
  const d = req.body.item || {};
  if (!d.id || !d.startDate || !d.endDate) return res.status(400).json({ ok: false, error: 'bad_request' });
  const oldRow = ENTITIES.dossier.getRow(d.id);
  saveDossierRow(d);
  recordDossierHistory(oldRow, d, req.session.username);
  recordAction('dossier', d.id, oldRow ? 'update' : 'create', oldRow, ENTITIES.dossier.getRow(d.id), req.session.username);
  broadcast();
  res.json({ ok: true });
});
app.delete('/api/dossiers/:id', requireAuth, requireWrite, (req, res) => {
  const before = ENTITIES.dossier.getRow(req.params.id);
  removeDossierRow(req.params.id);
  if (before) recordAction('dossier', req.params.id, 'delete', before, null, req.session.username);
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
  const before = ENTITIES.assignment.getRow(a.id);
  saveAssignmentRow(a);
  recordAction('assignment', a.id, before ? 'update' : 'create', before, ENTITIES.assignment.getRow(a.id), req.session.username);
  broadcast();
  res.json({ ok: true });
});

app.post('/api/absences', requireAuth, requireWrite, (req, res) => {
  const a = req.body.item || {};
  if (!a.id || !a.employeeId || !a.reason || !a.startDate || !a.endDate) return res.status(400).json({ ok: false, error: 'bad_request' });
  const before = ENTITIES.absence.getRow(a.id);
  saveAbsenceRow(a);
  recordAction('absence', a.id, before ? 'update' : 'create', before, ENTITIES.absence.getRow(a.id), req.session.username);
  broadcast();
  res.json({ ok: true });
});
app.delete('/api/absences/:id', requireAuth, requireWrite, (req, res) => {
  const before = ENTITIES.absence.getRow(req.params.id);
  removeAbsenceRow(req.params.id);
  if (before) recordAction('absence', req.params.id, 'delete', before, null, req.session.username);
  broadcast();
  res.json({ ok: true });
});

app.post('/api/vehicle-downtimes', requireAuth, requireWrite, (req, res) => {
  const v = req.body.item || {};
  if (!v.id || !v.vehicleId || !v.reason || !v.startDate || !v.endDate) return res.status(400).json({ ok: false, error: 'bad_request' });
  const before = ENTITIES.downtime.getRow(v.id);
  saveDowntimeRow(v);
  recordAction('downtime', v.id, before ? 'update' : 'create', before, ENTITIES.downtime.getRow(v.id), req.session.username);
  broadcast();
  res.json({ ok: true });
});
app.delete('/api/vehicle-downtimes/:id', requireAuth, requireWrite, (req, res) => {
  const before = ENTITIES.downtime.getRow(req.params.id);
  removeDowntimeRow(req.params.id);
  if (before) recordAction('downtime', req.params.id, 'delete', before, null, req.session.username);
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
  const { salt, hash } = hashPassword(password);
  db.prepare('INSERT INTO users (username, salt, hash, role) VALUES (?, ?, ?, ?)').run(username, salt, hash, role);
  res.json({ ok: true });
});
app.post('/api/users/:username/reset-password', requireAuth, requireAdmin, (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 4) return res.status(400).json({ ok: false, error: 'bad_request' });
  const exists = db.prepare('SELECT 1 FROM users WHERE username = ?').get(req.params.username);
  if (!exists) return res.json({ ok: false, error: 'not_found' });
  const { salt, hash } = hashPassword(password);
  db.prepare('UPDATE users SET salt = ?, hash = ? WHERE username = ?').run(salt, hash, req.params.username);
  // An admin resetting the password is an authorized override — don't leave
  // the account locked out from whatever failed attempts led to the reset.
  clearRateLimit('user', req.params.username);
  res.json({ ok: true });
});
app.delete('/api/users/:username', requireAuth, requireAdmin, (req, res) => {
  if (req.params.username === req.session.username) return res.json({ ok: false, error: 'cannot_delete_self' });
  db.prepare('DELETE FROM users WHERE username = ?').run(req.params.username);
  res.json({ ok: true });
});

// ---------- backups API (admin only) ----------
const BACKUP_FILENAME_RE = /^planning-[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}h[0-9]{2}\.db$|^avant-restauration-[0-9-]+\.db$|^avant-deploiement-[0-9-]+_[0-9]{2}h[0-9]{2}\.db$/;

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
