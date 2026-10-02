const { test, expect } = require('@playwright/test');
const { login, createDossier, dossierCardByName } = require('./helpers');

test.describe('Mise en évidence des ressources mobilisées (Dashboard + vue Semaine)', () => {
  test('le tableau hebdomadaire du Dashboard colore ses 3 lignes principales', async ({ page }) => {
    await login(page);
    await page.click('[data-tab="dashboard"]');
    await page.waitForTimeout(600);

    const rows = page.locator('#dashWeekTable tr.week-main');
    await expect(rows).toHaveCount(3);
    await expect(page.locator('#dashWeekTable tr.week-row-dossiers')).toContainText('Chantiers');
    await expect(page.locator('#dashWeekTable tr.week-row-emp')).toContainText('Effectif mobilisé');
    await expect(page.locator('#dashWeekTable tr.week-row-veh')).toContainText('Véhicules mobilisés');

    const borderColor = await page.locator('#dashWeekTable tr.week-row-dossiers td.week-metric-label').evaluate(
      (el) => getComputedStyle(el).borderLeftColor
    );
    expect(borderColor).not.toBe('rgba(0, 0, 0, 0)'); // a colored border is actually applied, not just transparent
  });

  test("la vue Semaine du planning affiche un badge coloré d'effectif mobilisé par jour", async ({ page }) => {
    await login(page);
    await page.click('#goTodayBtn');
    await page.waitForTimeout(300);
    await createDossier(page, 'E2E Badge Effectif Semaine');
    const card = await dossierCardByName(page, 'E2E Badge Effectif Semaine');
    await card.locator('.chips .add-chip').first().click();
    await page.waitForTimeout(300);
    await page.locator('.popover .opt', { hasText: 'PEL-ROSALES Oscar' }).click();
    await page.waitForTimeout(500);

    await page.click('#viewModeWeekBtn');
    await page.waitForTimeout(600);
    const badges = page.locator('.week-day-empcount-item');
    await expect(badges.first()).toBeVisible();
    const bg = await badges.first().evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe('rgba(0, 0, 0, 0)');
  });
});
