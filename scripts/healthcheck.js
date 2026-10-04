// Pings the app's public /api/health endpoint and sends a Telegram alert on
// a STATE CHANGE (went down, came back up, disk crossed into/out of the low
// zone, Drive sync started/stopped failing) — not on every run, so a known
// ongoing outage doesn't spam the same alert every 10 minutes.
//
// Run by .github/workflows/healthcheck.yml on a schedule. Needs
// TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID (repo secrets) to actually send;
// without them it just logs what it would have sent, so the check itself
// still runs (and the state file still updates) even before those are set up.

const fs = require('fs');

const URL = process.env.HEALTHCHECK_URL;
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const STATE_FILE = process.env.STATE_FILE || 'healthcheck-state.json';
const FORCE_TEST_ALERT = process.env.FORCE_TEST_ALERT === 'true';
const DISK_LOW_THRESHOLD_PCT = 10;

function loadPrevState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (err) { return { up: true, diskLow: false, driveSyncFailed: false }; }
}

async function sendTelegram(text) {
  if (!TOKEN || !CHAT_ID) {
    console.log('(Telegram not configured — TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID missing) Would have sent:', text);
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text }),
  });
  if (!res.ok) console.error('Telegram send failed:', res.status, await res.text());
  else console.log('Telegram alert sent:', text);
}

(async () => {
  if (!URL) { console.error('HEALTHCHECK_URL is not set.'); process.exit(1); }
  const prev = loadPrevState();

  let up = false, health = null;
  try {
    const res = await fetch(URL, { signal: AbortSignal.timeout(15000) });
    if (res.ok) { health = await res.json(); up = true; }
  } catch (err) {
    console.error('Health check request failed:', err.message);
  }

  const diskPct = health && typeof health.diskFreePercent === 'number' ? health.diskFreePercent : null;
  const diskLow = up && diskPct !== null && diskPct < DISK_LOW_THRESHOLD_PCT;
  const driveSyncFailed = up && !!(health && health.driveSyncStatus && health.driveSyncStatus.ok === false);

  const messages = [];
  if (prev.up && !up) messages.push(`🔴 Planning Effectifs est injoignable (${URL}).`);
  if (!prev.up && up) messages.push(`✅ Planning Effectifs est de nouveau accessible.`);
  if (!prev.diskLow && diskLow) messages.push(`⚠️ Espace disque faible sur le VPS : ${diskPct}% libre.`);
  if (prev.diskLow && !diskLow && up) messages.push(`✅ Espace disque du VPS revenu à un niveau normal (${diskPct}% libre).`);
  if (!prev.driveSyncFailed && driveSyncFailed) {
    messages.push(`⚠️ Échec de la dernière synchro Google Drive : ${health.driveSyncStatus.error || 'raison inconnue'}.`);
  }
  if (prev.driveSyncFailed && !driveSyncFailed && up) messages.push('✅ La synchro Google Drive fonctionne de nouveau.');
  // Manual-only (workflow_dispatch "test_alert" input), forces a real send
  // through this exact code path + the configured secrets, independent of
  // whether any real state actually changed — the normal state-change logic
  // above is what the unattended schedule relies on and isn't affected by this.
  if (FORCE_TEST_ALERT) messages.push(`🧪 Test manuel : l'automatisation (script + secrets GitHub) fonctionne. État actuel : ${up ? 'en ligne' : 'injoignable'}.`);

  for (const msg of messages) await sendTelegram(msg);

  fs.writeFileSync(STATE_FILE, JSON.stringify({ up, diskLow, driveSyncFailed }));
  console.log('State:', { up, diskLow, driveSyncFailed }, messages.length ? `${messages.length} alert(s) sent.` : 'No change — no alert.');
})();
