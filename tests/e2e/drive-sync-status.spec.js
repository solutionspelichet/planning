const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

// rclone isn't installed in CI/this sandbox, so triggering a real backup
// exercises the genuine failure path (spawn rclone ENOENT) rather than a
// simulation — a good thing, since that's exactly the "silent failure"
// scenario this status banner exists to surface.
test.describe("Statut de synchro Google Drive (onglet Admin)", () => {
  test('affiche un avertissement quand la synchro rclone échoue (rclone absent ici)', async ({ page }) => {
    await login(page);
    await page.click('[data-tab="admin"]');
    await page.waitForTimeout(400);

    await page.click('#runBackupBtn');
    await page.waitForTimeout(1500);

    const status = page.locator('#driveSyncStatus');
    await expect(status.locator('.capacity-warning')).toContainText('Échec de la dernière synchro Google Drive');
  });

  test('affiche un statut positif quand une synchro récente a réussi', async ({ page }) => {
    await login(page);
    await page.click('[data-tab="admin"]');
    await page.waitForTimeout(400);

    await page.evaluate(async () => {
      const token = JSON.parse(localStorage.getItem('pe_session_v1')).token;
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Auth-Token': token },
        body: JSON.stringify({ values: { driveSyncStatus: JSON.stringify({ ok: true, at: Date.now() }) } }),
      });
    });
    await page.waitForTimeout(800);

    const status = page.locator('#driveSyncStatus');
    await expect(status).toContainText('Dernière synchro Google Drive réussie');
    await expect(status.locator('.capacity-warning')).toHaveCount(0);
  });

  test("avertit quand une synchro 'ok' date de plus de 15h (sauvegardes probablement à l'arrêt)", async ({ page }) => {
    await login(page);
    await page.click('[data-tab="admin"]');
    await page.waitForTimeout(400);

    await page.evaluate(async () => {
      const token = JSON.parse(localStorage.getItem('pe_session_v1')).token;
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Auth-Token': token },
        body: JSON.stringify({ values: { driveSyncStatus: JSON.stringify({ ok: true, at: Date.now() - 20 * 3600 * 1000 }) } }),
      });
    });
    await page.waitForTimeout(800);

    const status = page.locator('#driveSyncStatus');
    await expect(status.locator('.capacity-warning')).toContainText('Pas de synchro Google Drive réussie');
  });
});
