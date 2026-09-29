/**
 * Planning Effectifs — backend (Google Apps Script)
 *
 * Deploy this as a Web App ("Exécuter en tant que : Moi", "Qui a accès : Tout
 * le monde"). It stores all data as JSON files in the Drive folder below and
 * never keeps any plaintext password anywhere — only salted SHA-256 hashes.
 *
 * SETUP — see the numbered steps the person you're helping was given; the
 * only thing to edit here is FOLDER_ID below if you recreate the folder.
 */

var FOLDER_ID = '17xy0OdRBzImQx3Hbp6W5oyIQwIzy3VeA'; // Drive folder "planning"
var SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

var FILES = {
  users: 'users.json',
  employees: 'employees.json',
  vehicles: 'vehicles.json',
  dossiers: 'dossiers.json',
  assignments: 'assignments.json',
  sessions: 'sessions.json'
};

// ---------- storage helpers ----------

function getFile_(name) {
  var folder = DriveApp.getFolderById(FOLDER_ID);
  var it = folder.getFilesByName(name);
  if (it.hasNext()) return it.next();
  var f = folder.createFile(name, '[]', MimeType.PLAIN_TEXT);
  return f;
}

function readJson_(name) {
  var file = getFile_(name);
  var text = file.getBlob().getDataAsString('UTF-8') || '[]';
  try { return JSON.parse(text); } catch (e) { return []; }
}

function writeJson_(name, data) {
  var file = getFile_(name);
  file.setContent(JSON.stringify(data));
}

/** Runs fn() while holding a script lock, so two simultaneous requests never
 * clobber each other's read-modify-write on the same file. */
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

// ---------- crypto / sessions ----------

function sha256Hex_(text) {
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return raw.map(function(b) { var v = (b < 0 ? b + 256 : b).toString(16); return v.length === 1 ? '0' + v : v; }).join('');
}
function randomToken_() {
  return Utilities.getUuid() + Utilities.getUuid();
}

function findUser_(users, username) {
  for (var i = 0; i < users.length; i++) if (users[i].username === username) return users[i];
  return null;
}

function login_(payload) {
  var users = readJson_(FILES.users);
  var user = findUser_(users, payload.username);
  if (!user) return {ok: false, error: 'invalid_credentials'};
  var hash = sha256Hex_(user.salt + payload.password);
  if (hash !== user.hash) return {ok: false, error: 'invalid_credentials'};
  var token = randomToken_();
  return withLock_(function() {
    var sessions = readJson_(FILES.sessions);
    sessions = sessions.filter(function(s) { return s.expires > Date.now(); }); // prune expired
    sessions.push({token: token, username: user.username, role: user.role, expires: Date.now() + SESSION_TTL_MS});
    writeJson_(FILES.sessions, sessions);
    return {ok: true, token: token, username: user.username, role: user.role};
  });
}

function sessionFor_(token) {
  if (!token) return null;
  var sessions = readJson_(FILES.sessions);
  var s = null;
  for (var i = 0; i < sessions.length; i++) if (sessions[i].token === token) { s = sessions[i]; break; }
  if (!s || s.expires < Date.now()) return null;
  return s;
}

// role check: "admin" > "planning" > "user"
function canWrite_(role) { return role === 'admin' || role === 'planning'; }
function isAdmin_(role) { return role === 'admin'; }

// ---------- request router ----------

function doPost(e) {
  var payload = {};
  try { payload = JSON.parse(e.postData.contents); } catch (err) { return json_({ok: false, error: 'bad_request'}); }
  var action = payload.action;

  if (action === 'login') return json_(login_(payload));

  var session = sessionFor_(payload.token);
  if (!session) return json_({ok: false, error: 'not_authenticated'});

  switch (action) {
    case 'getAll':
      return json_({
        ok: true,
        role: session.role,
        username: session.username,
        employees: readJson_(FILES.employees),
        vehicles: readJson_(FILES.vehicles),
        dossiers: readJson_(FILES.dossiers),
        assignments: readJson_(FILES.assignments)
      });

    case 'saveEmployee': return json_(upsert_(FILES.employees, payload.item, session.role));
    case 'deleteEmployee': return json_(remove_(FILES.employees, payload.id, session.role));
    case 'saveVehicle': return json_(upsert_(FILES.vehicles, payload.item, session.role));
    case 'deleteVehicle': return json_(remove_(FILES.vehicles, payload.id, session.role));
    case 'saveDossier': return json_(upsert_(FILES.dossiers, payload.item, session.role));
    case 'deleteDossier': return json_(deleteDossierCascade_(payload.id, session.role));
    case 'saveAssignment': return json_(upsertAssignment_(payload.item, session.role));

    case 'listUsers':
      if (!isAdmin_(session.role)) return json_({ok: false, error: 'forbidden'});
      var users = readJson_(FILES.users).map(function(u) { return {username: u.username, role: u.role}; });
      return json_({ok: true, users: users});

    case 'createUser':
      if (!isAdmin_(session.role)) return json_({ok: false, error: 'forbidden'});
      return json_(createUser_(payload.username, payload.password, payload.role));

    case 'deleteUser':
      if (!isAdmin_(session.role)) return json_({ok: false, error: 'forbidden'});
      if (payload.username === session.username) return json_({ok: false, error: 'cannot_delete_self'});
      return json_(withLock_(function() {
        var us = readJson_(FILES.users).filter(function(u) { return u.username !== payload.username; });
        writeJson_(FILES.users, us);
        return {ok: true};
      }));

    default:
      return json_({ok: false, error: 'unknown_action'});
  }
}

function doGet(e) {
  return ContentService.createTextOutput('Planning Effectifs API is running.');
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------- collection helpers (role-gated writes) ----------

function upsert_(fileName, item, role) {
  if (!canWrite_(role)) return {ok: false, error: 'forbidden'};
  if (!item || !item.id) return {ok: false, error: 'bad_request'};
  return withLock_(function() {
    var list = readJson_(fileName);
    var idx = list.findIndex(function(x) { return x.id === item.id; });
    if (idx === -1) list.push(item); else list[idx] = item;
    writeJson_(fileName, list);
    return {ok: true};
  });
}

function remove_(fileName, id, role) {
  if (!canWrite_(role)) return {ok: false, error: 'forbidden'};
  return withLock_(function() {
    var list = readJson_(fileName).filter(function(x) { return x.id !== id; });
    writeJson_(fileName, list);
    return {ok: true};
  });
}

function upsertAssignment_(item, role) {
  if (!canWrite_(role)) return {ok: false, error: 'forbidden'};
  if (!item || !item.id) return {ok: false, error: 'bad_request'};
  return withLock_(function() {
    var list = readJson_(FILES.assignments);
    var idx = list.findIndex(function(x) { return x.id === item.id; });
    if (idx === -1) list.push(item); else list[idx] = item;
    writeJson_(FILES.assignments, list);
    return {ok: true};
  });
}

function deleteDossierCascade_(dossierId, role) {
  if (!canWrite_(role)) return {ok: false, error: 'forbidden'};
  return withLock_(function() {
    var dossiers = readJson_(FILES.dossiers).filter(function(d) { return d.id !== dossierId; });
    writeJson_(FILES.dossiers, dossiers);
    var assignments = readJson_(FILES.assignments).filter(function(a) { return a.dossierId !== dossierId; });
    writeJson_(FILES.assignments, assignments);
    return {ok: true};
  });
}

function createUser_(username, password, role) {
  if (!username || !password || ['admin', 'planning', 'user'].indexOf(role) === -1) {
    return {ok: false, error: 'bad_request'};
  }
  return withLock_(function() {
    var users = readJson_(FILES.users);
    if (findUser_(users, username)) return {ok: false, error: 'username_taken'};
    var salt = Utilities.getUuid();
    var hash = sha256Hex_(salt + password);
    users.push({username: username, salt: salt, hash: hash, role: role});
    writeJson_(FILES.users, users);
    return {ok: true};
  });
}
