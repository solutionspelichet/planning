const { test, expect } = require('@playwright/test');
const { login, createDossier, dossierCardByName } = require('./helpers');

// Drag-reorder itself isn't exercised here — no spec in this suite drives
// the HTML5 drag gestures behind enableDragReorder() (used by the dossier
// list, Effectifs and Véhicules too), so this follows that same precedent
// and sticks to the checkbox/select/color-input path, which is what an
// admin actually uses to hide a field or set its accent color.
test.describe('Settings : mise en page de la fiche chantier', () => {
  test.afterEach(async ({ page }) => {
    // Leave the shared layout as the default for every other spec file's
    // dossier-card assertions, regardless of whether this test passed.
    await page.click('[data-tab="settings"]').catch(() => {});
    const resetBtn = page.locator('#resetDossierFieldLayoutBtn');
    if (await resetBtn.count()) {
      await resetBtn.click();
      await page.click('#saveSettingsBtn');
      await page.waitForTimeout(500);
    }
  });

  test('masquer un champ et lui donner une couleur se reflète sur la fiche chantier', async ({ page }) => {
    await login(page);
    await page.click('[data-tab="settings"]');
    await page.waitForSelector('#dossierFieldLayoutList .dossier-field-row', { timeout: 10000 });

    const rows = page.locator('#dossierFieldLayoutList .dossier-field-row');
    await expect(rows).toHaveCount(19);
    await expect(rows.first().locator('.emp-name')).toHaveText('N° dossier');

    const numberRow = page.locator('.dossier-field-row', { hasText: 'N° dossier' });
    await numberRow.locator('input[type=color]').fill('#ff0000');
    const sellerRow = page.locator('.dossier-field-row', { hasText: 'Vendeur' });
    await sellerRow.locator('input[type=checkbox]').uncheck();

    await page.click('#saveSettingsBtn');
    await page.waitForTimeout(600);

    await page.click('[data-tab="planning"]');
    await page.waitForTimeout(400);
    await createDossier(page, 'E2E Layout Fields');
    const card = await dossierCardByName(page, 'E2E Layout Fields');

    await expect(card.locator('.info-field', { hasText: 'Vendeur' })).toHaveCount(0);
    const numberBorder = await card.locator('input[placeholder="N° dossier"]').evaluate((input) => input.closest('.info-field').style.borderLeft);
    expect(numberBorder).toContain('rgb(255, 0, 0)');
  });

  test('réinitialiser la mise en page restaure l\'ordre et la visibilité par défaut', async ({ page }) => {
    await login(page);
    await page.click('[data-tab="settings"]');
    await page.waitForSelector('#dossierFieldLayoutList .dossier-field-row', { timeout: 10000 });

    await page.locator('.dossier-field-row', { hasText: 'Commentaire' }).locator('input[type=checkbox]').uncheck();
    await page.click('#saveSettingsBtn');
    await page.waitForTimeout(600);

    await page.click('[data-tab="planning"]');
    await page.waitForTimeout(300);
    await createDossier(page, 'E2E Layout Reset Before');
    let card = await dossierCardByName(page, 'E2E Layout Reset Before');
    await expect(card.locator('.info-field', { hasText: 'Commentaire' })).toHaveCount(0);

    await page.click('[data-tab="settings"]');
    await page.waitForTimeout(300);
    await page.click('#resetDossierFieldLayoutBtn');
    await page.click('#saveSettingsBtn');
    await page.waitForTimeout(600);

    await page.click('[data-tab="planning"]');
    await page.waitForTimeout(300);
    await createDossier(page, 'E2E Layout Reset After');
    card = await dossierCardByName(page, 'E2E Layout Reset After');
    await expect(card.locator('.info-field', { hasText: 'Commentaire' })).toHaveCount(1);
  });
});
