const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

// Regression test for a real bug: the server broadcasts an SSE "changed"
// event to every open tab the instant ANY client writes ANYTHING, anywhere
// in the app (see server.js broadcast()). Settings used to resync its
// unsaved draft from state.settings on every one of those refreshes, so an
// admin mid-edit in Settings would see their own unsaved change silently
// revert to the last-saved value the moment someone (or something, like the
// backup job) wrote elsewhere in the app — before they ever clicked
// "Enregistrer".
test.describe('Settings : le brouillon non enregistré résiste à un rafraîchissement en arrière-plan', () => {
  test('une case décochée dans Settings reste décochée après une écriture déclenchée ailleurs', async ({ page }) => {
    await login(page);
    await page.click('[data-tab="settings"]');
    await page.waitForSelector('#dossierFieldLayoutList .dossier-field-row', { timeout: 10000 });

    const sellerCheckbox = page.locator('.dossier-field-row', { hasText: 'Vendeur' }).locator('input[type=checkbox]');
    await expect(sellerCheckbox).toBeChecked();
    await sellerCheckbox.uncheck();
    await expect(sellerCheckbox).not.toBeChecked();

    // Trigger an unrelated write (not a "saveSettings" call) from the same
    // page, which the server broadcasts to every connected client — this
    // page's own EventSource included — causing a live refreshAll().
    const token = await page.evaluate(() => JSON.parse(localStorage.getItem('pe_session_v1')).token);
    await page.evaluate(async (token) => {
      await fetch('/api/employees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Auth-Token': token },
        body: JSON.stringify({ item: { id: 'e2e-refresh-probe', name: 'E2E Refresh Probe', company: 'Pelichet' } }),
      });
    }, token);

    // Give the SSE message time to arrive and refreshAll() to re-render Settings.
    await page.waitForTimeout(1200);

    await expect(sellerCheckbox).not.toBeChecked();

    // Cleanup: remove the probe employee; no settings were ever saved, so
    // the server-side layout config was never touched and needs no reset.
    await page.evaluate(async (token) => {
      await fetch('/api/employees/e2e-refresh-probe', { method: 'DELETE', headers: { 'X-Auth-Token': token } });
    }, token);
  });
});
