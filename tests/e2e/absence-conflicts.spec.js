const { test, expect } = require('@playwright/test');
const { login, createDossier, dossierCardByName } = require('./helpers');

test.describe('Alerte quand une ressource assignée est aussi absente/immobilisée', () => {
  test('affecter un employé puis le marquer absent le même jour affiche une alerte 🚫', async ({ page }) => {
    await login(page);
    await page.click('#goTodayBtn');
    await page.waitForTimeout(300);

    await createDossier(page, 'E2E Conflit Absence');
    const card = await dossierCardByName(page, 'E2E Conflit Absence');
    await card.locator('.chips .add-chip').first().click();
    await page.waitForTimeout(300);
    await page.locator('.popover .opt', { hasText: 'PEL-RODRIGUES Octavio' }).click();
    await page.waitForTimeout(400);

    await expect(card.locator('.capacity-warning')).toHaveCount(0);

    await page.click('[data-tab="vacances"]');
    await page.waitForTimeout(400);
    const todayStr = await page.evaluate(() => new Date().toISOString().slice(0, 10));
    await page.evaluate((todayStr) => {
      const sel = document.getElementById('newAbsenceEmp');
      const opt = Array.from(sel.options).find((o) => o.textContent === 'PEL-RODRIGUES Octavio');
      sel.value = opt.value;
      document.getElementById('newAbsenceReason').value = 'Maladie';
      document.getElementById('newAbsenceStart').value = todayStr;
      document.getElementById('newAbsenceEnd').value = todayStr;
    }, todayStr);
    await page.click('#addAbsenceBtn');
    await page.waitForTimeout(600);

    await page.click('[data-tab="planning"]');
    await page.waitForTimeout(400);
    const refreshedCard = await dossierCardByName(page, 'E2E Conflit Absence');
    await expect(refreshedCard.locator('.capacity-warning')).toContainText('est en absence/congé ce jour-là');
  });

  test("le badge de l'app augmente quand un conflit d'absence apparaît", async ({ page }) => {
    await page.addInitScript(() => {
      window.__badgeCalls = [];
      navigator.setAppBadge = (n) => {
        window.__badgeCalls.push(n);
        return Promise.resolve();
      };
    });
    await login(page);
    await page.click('#goTodayBtn');
    await page.waitForTimeout(300);

    await createDossier(page, 'E2E Badge Conflit');
    const card = await dossierCardByName(page, 'E2E Badge Conflit');
    await card.locator('.chips .add-chip').first().click();
    await page.waitForTimeout(300);
    await page.locator('.popover .opt', { hasText: 'PEL-CORAZZOL Christophe' }).click();
    await page.waitForTimeout(500);

    const badgeBefore = await page.evaluate(() => window.__badgeCalls[window.__badgeCalls.length - 1] || 0);

    await page.click('[data-tab="vacances"]');
    await page.waitForTimeout(400);
    const todayStr = await page.evaluate(() => new Date().toISOString().slice(0, 10));
    await page.evaluate((todayStr) => {
      const sel = document.getElementById('newAbsenceEmp');
      const opt = Array.from(sel.options).find((o) => o.textContent === 'PEL-CORAZZOL Christophe');
      sel.value = opt.value;
      document.getElementById('newAbsenceReason').value = 'Congés';
      document.getElementById('newAbsenceStart').value = todayStr;
      document.getElementById('newAbsenceEnd').value = todayStr;
    }, todayStr);
    await page.click('#addAbsenceBtn');
    await page.waitForTimeout(700);

    const badgeAfter = await page.evaluate(() => window.__badgeCalls[window.__badgeCalls.length - 1] || 0);
    expect(badgeAfter).toBeGreaterThan(badgeBefore);
  });
});
