const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

// Drag-reorder itself isn't exercised here, same precedent as
// dossier-card-layout.spec.js — see that file's comment.
test.describe('Settings : mise en page du Dashboard', () => {
  test.afterEach(async ({ page }) => {
    // Leave the shared layout as the default for every other spec file's
    // Dashboard assertions, regardless of whether this test passed.
    await page.click('[data-tab="settings"]').catch(() => {});
    const resetBtn = page.locator('#resetDashboardLayoutBtn');
    if (await resetBtn.count()) {
      await resetBtn.click();
      await page.click('#saveSettingsBtn');
      await page.waitForTimeout(500);
    }
  });

  test('masquer un widget et lui donner une couleur se reflète sur le Dashboard', async ({ page }) => {
    await login(page);
    await page.click('[data-tab="settings"]');
    await page.waitForSelector('#dashboardLayoutList .dashboard-field-row', { timeout: 10000 });

    const rows = page.locator('#dashboardLayoutList .dashboard-field-row');
    await expect(rows).toHaveCount(7);
    await expect(rows.first().locator('.emp-name')).toHaveText('Chiffres clés');

    await page.locator('.dashboard-field-row', { hasText: 'Répartition par type' }).locator('input[type=checkbox]').uncheck();
    const statsRow = page.locator('.dashboard-field-row', { hasText: 'Chiffres clés' });
    await statsRow.locator('input[type=color]').fill('#00ff00');

    await page.click('#saveSettingsBtn');
    await page.waitForTimeout(600);

    await page.click('[data-tab="dashboard"]');
    await page.waitForTimeout(400);

    await expect(page.locator('[data-widget="typeDistribution"]')).toBeHidden();
    const statsBorder = await page.locator('[data-widget="stats"]').evaluate((el) => el.style.borderLeft);
    expect(statsBorder).toContain('rgb(0, 255, 0)');
  });

  test('réinitialiser la mise en page restaure l\'ordre et la visibilité par défaut', async ({ page }) => {
    await login(page);
    await page.click('[data-tab="settings"]');
    await page.waitForSelector('#dashboardLayoutList .dashboard-field-row', { timeout: 10000 });

    await page.locator('.dashboard-field-row', { hasText: 'Volume transporté par mois' }).locator('input[type=checkbox]').uncheck();
    await page.click('#saveSettingsBtn');
    await page.waitForTimeout(600);

    await page.click('[data-tab="dashboard"]');
    await page.waitForTimeout(300);
    await expect(page.locator('[data-widget="chartVolume"]')).toBeHidden();

    await page.click('[data-tab="settings"]');
    await page.waitForTimeout(300);
    await page.click('#resetDashboardLayoutBtn');
    await page.click('#saveSettingsBtn');
    await page.waitForTimeout(600);

    await page.click('[data-tab="dashboard"]');
    await page.waitForTimeout(300);
    await expect(page.locator('[data-widget="chartVolume"]')).toBeVisible();
    const order = await page.$$eval('#dashboardWidgets [data-widget]', (els) => els.map((e) => e.dataset.widget));
    expect(order).toEqual(['stats', 'mobilization', 'typeDistribution', 'chartDossiers', 'chartEmployees', 'chartVehicles', 'chartVolume']);
  });
});
