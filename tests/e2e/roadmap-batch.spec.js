const { test, expect } = require('@playwright/test');
const { login, createDossier, dossierCardByName } = require('./helpers');

test.describe('Numéro de dossier en double', () => {
  test("avertit quand deux dossiers partagent le même N°", async ({ page }) => {
    await login(page);
    await createDossier(page, 'E2E DupNum A');
    await createDossier(page, 'E2E DupNum B');

    async function setNumber(name, number) {
      const card = await dossierCardByName(page, name);
      const input = card.locator('.info-field.wide input').first();
      await input.fill(number);
      await input.dispatchEvent('change');
      await page.waitForTimeout(400);
    }
    await setNumber('E2E DupNum A', 'DUPNUM-1');
    await setNumber('E2E DupNum B', 'DUPNUM-1');

    const cardB = await dossierCardByName(page, 'E2E DupNum B');
    await expect(cardB.locator('.capacity-warning')).toContainText('déjà utilisé par un autre dossier');
  });
});

test.describe('Export PDF de la semaine', () => {
  test('télécharge un PDF valide pour les 7 jours', async ({ page }) => {
    await login(page);
    await page.click('#viewModeWeekBtn');
    await page.waitForTimeout(400);
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#exportWeekPdfBtn')]);
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const buf = Buffer.concat(chunks);
    expect(buf.slice(0, 5).toString('latin1')).toBe('%PDF-');
  });
});

test.describe('Raccourci clavier', () => {
  test('Ctrl+K donne le focus à la recherche', async ({ page }) => {
    await login(page);
    await page.keyboard.press('Control+k');
    await expect(page.locator('#globalSearch')).toBeFocused();
  });
});

test.describe('Archivage des vieux dossiers', () => {
  test("un dossier terminé il y a plus de 18 mois n'apparaît plus dans /api/all mais reste trouvable dans les archives", async ({ page }) => {
    await login(page);
    await createDossier(page, 'E2E Archive Old');
    const card = await dossierCardByName(page, 'E2E Archive Old');
    const id = await card.getAttribute('data-id');

    const oldDate = new Date();
    oldDate.setMonth(oldDate.getMonth() - 20);
    const p = (n) => String(n).padStart(2, '0');
    const oldDateStr = `${oldDate.getFullYear()}-${p(oldDate.getMonth() + 1)}-${p(oldDate.getDate())}`;

    await page.evaluate(async ({ id, oldDateStr, token }) => {
      // No UI path reaches a date this old (the calendar only browses nearby
      // months) — go through the same saveDossier endpoint the app itself
      // uses, just with a backdated range, rather than touching the DB file.
      await fetch('/api/dossiers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Auth-Token': token },
        body: JSON.stringify({ item: { id, client: 'E2E Archive Old', startDate: oldDateStr, endDate: oldDateStr } }),
      });
    }, { id, oldDateStr, token: await page.evaluate(() => JSON.parse(localStorage.getItem('pe_session_v1')).token) });

    await page.reload();
    await page.waitForSelector('#mainApp:not([hidden])', { timeout: 15000 });
    await page.waitForTimeout(600);

    const stillPresent = await page.evaluate(async () => {
      const token = JSON.parse(localStorage.getItem('pe_session_v1')).token;
      const r = await fetch('/api/all', { headers: { 'X-Auth-Token': token } });
      const j = await r.json();
      return j.dossiers.some((d) => d.client === 'E2E Archive Old');
    });
    expect(stillPresent).toBe(false);

    await page.click('[data-tab="admin"]');
    await page.waitForTimeout(400);
    await page.fill('#archiveSearchInput', 'Archive Old');
    await page.waitForTimeout(700);
    await expect(page.locator('#archiveResults')).toContainText('E2E Archive Old');
  });
});

test.describe('Réinitialisation de mot de passe lève le blocage', () => {
  test("un admin qui réinitialise le mot de passe d'un compte bloqué le débloque immédiatement", async ({ page }) => {
    await login(page);
    const token = await page.evaluate(() => JSON.parse(localStorage.getItem('pe_session_v1')).token);

    const username = 'e2e-lockout-user';
    await page.evaluate(async ({ username, token }) => {
      await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Auth-Token': token },
        body: JSON.stringify({ username, password: 'initial-pass-1', role: 'user' }),
      });
    }, { username, token });

    // Lock it out with 5 failed logins
    for (let i = 0; i < 5; i++) {
      await page.evaluate(async (username) => {
        await fetch('/api/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password: 'wrong-' + Math.random() }),
        });
      }, username);
    }
    const lockedResult = await page.evaluate(async (username) => {
      const r = await fetch('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: 'initial-pass-1' }),
      });
      return r.json();
    }, username);
    expect(lockedResult).toEqual({ ok: false, error: 'too_many_attempts' });

    // Admin resets the password
    await page.evaluate(async ({ username, token }) => {
      await fetch(`/api/users/${username}/reset-password`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Auth-Token': token },
        body: JSON.stringify({ password: 'new-pass-2' }),
      });
    }, { username, token });

    // Should be able to log in immediately with the new password — no 5-minute wait
    const afterReset = await page.evaluate(async (username) => {
      const r = await fetch('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: 'new-pass-2' }),
      });
      return r.json();
    }, username);
    expect(afterReset.ok).toBe(true);
  });
});
