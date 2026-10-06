const { test, expect } = require('@playwright/test');
const { login, createDossier, dossierCardByName } = require('./helpers');

// Drag-reorder itself isn't exercised here — no spec in this suite drives
// the HTML5 drag gestures behind enableDragReorder() (used by the dossier
// list, Effectifs and Véhicules too). The 3-column editor splits the field
// catalogue (left list, click to select) from its settings (detail column:
// visible/width/color for whichever field is selected), so every test here
// selects a field by clicking its row before touching the detail controls.
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

    await page.locator('.dossier-field-row', { hasText: 'N° dossier' }).click();
    await page.locator('#dossierFieldDetail input[type=color]').fill('#ff0000');

    await page.locator('.dossier-field-row', { hasText: 'Vendeur' }).click();
    await page.locator('#dossierFieldDetail input[type=checkbox]').uncheck();

    await page.click('#saveSettingsBtn');
    await page.waitForTimeout(600);

    await page.click('[data-tab="planning"]');
    await page.waitForTimeout(400);
    await createDossier(page, 'E2E Layout Fields');
    const card = await dossierCardByName(page, 'E2E Layout Fields');

    await expect(card.locator('.info-field', { hasText: 'Vendeur' })).toHaveCount(0);
    const numberInput = card.locator('input[placeholder="N° dossier"]');
    const numberBg = await numberInput.evaluate((input) => input.closest('.info-field').style.background);
    expect(numberBg).toContain('rgb(255, 0, 0)');
    // The input's own opaque background must be cleared, otherwise it
    // covers the colored box and only the padding ring around it shows —
    // looking like an outline instead of a filled background.
    const inputBg = await numberInput.evaluate((input) => getComputedStyle(input).backgroundColor);
    expect(inputBg).toBe('rgba(0, 0, 0, 0)');
  });

  test('réinitialiser la mise en page restaure l\'ordre et la visibilité par défaut', async ({ page }) => {
    await login(page);
    await page.click('[data-tab="settings"]');
    await page.waitForSelector('#dossierFieldLayoutList .dossier-field-row', { timeout: 10000 });

    await page.locator('.dossier-field-row', { hasText: 'Commentaire' }).click();
    await page.locator('#dossierFieldDetail input[type=checkbox]').uncheck();
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

  test('sélectionner un champ dans la liste affiche ses réglages dans la colonne du milieu', async ({ page }) => {
    await login(page);
    await page.click('[data-tab="settings"]');
    await page.waitForSelector('#dossierFieldLayoutList .dossier-field-row', { timeout: 10000 });

    await page.locator('.dossier-field-row', { hasText: 'Volume' }).click();
    await expect(page.locator('#dossierFieldDetail h4')).toHaveText('Volume');
    await expect(page.locator('.dossier-field-row', { hasText: 'Volume' })).toHaveClass(/selected/);

    await page.locator('.dossier-field-row', { hasText: 'Commentaire' }).click();
    await expect(page.locator('#dossierFieldDetail h4')).toHaveText('Commentaire');
    await expect(page.locator('.dossier-field-row', { hasText: 'Volume' })).not.toHaveClass(/selected/);
  });

  test('aperçu live dans Settings : se mettre à jour sans "Enregistrer" et rester en lecture seule', async ({ page }) => {
    await login(page);
    await page.click('[data-tab="settings"]');
    await page.waitForSelector('#dossierFieldLayoutList .dossier-field-row', { timeout: 10000 });
    const preview = page.locator('#dossierCardPreview .dossier-card');
    await expect(preview).toHaveCount(1);
    await expect(preview.locator('.info-field', { hasText: 'Vendeur' })).toHaveCount(1);

    // Uncheck "Vendeur" without saving — the preview must update live,
    // while the real settings (and any already-rendered dossier card) stay
    // untouched until "Enregistrer" is clicked.
    await page.locator('.dossier-field-row', { hasText: 'Vendeur' }).click();
    await page.locator('#dossierFieldDetail input[type=checkbox]').uncheck();
    await expect(preview.locator('.info-field', { hasText: 'Vendeur' })).toHaveCount(0);

    await page.locator('.dossier-field-row', { hasText: 'N° dossier' }).click();
    await page.locator('#dossierFieldDetail input[type=color]').fill('#0000ff');
    const numberBg = await preview.locator('input[placeholder="N° dossier"]').evaluate((input) => input.closest('.info-field').style.background);
    expect(numberBg).toContain('rgb(0, 0, 255)');

    // Every input/select/textarea/button inside the preview must be
    // disabled, so it can never write real data.
    const enabledCount = await preview.locator('input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])').count();
    expect(enabledCount).toBe(0);
  });
});
