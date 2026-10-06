const { test, expect } = require('@playwright/test');
const { login, createDossier, dossierCardByName } = require('./helpers');

test.describe('Settings : couleurs adresse (GM / transit dépôt)', () => {
  test('les deux pickers existent et alimentent l\'aperçu en direct', async ({ page }) => {
    await login(page);
    await page.click('[data-tab="settings"]');
    await page.waitForTimeout(400);
    const gmRow = page.locator('.settings-row', { hasText: 'Texte exactement « GM »' });
    const transitRow = page.locator('.settings-row', { hasText: 'transit depot' });
    await expect(gmRow.locator('input[type=color]')).toBeVisible();
    await expect(transitRow.locator('input[type=color]')).toBeVisible();
    await expect(page.locator('#settingsPreview')).toContainText('Adresse GM');
    await expect(page.locator('#settingsPreview')).toContainText('Adresse transit dépôt');
  });

  test('la couleur choisie dans Settings s\'applique au champ adresse selon le texte saisi', async ({ page }) => {
    await login(page);
    await page.click('[data-tab="settings"]');
    await page.waitForTimeout(400);
    const gmInput = page.locator('.settings-row', { hasText: 'Texte exactement « GM »' }).locator('input[type=color]');
    await gmInput.evaluate((el) => { el.value = '#123456'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.click('#saveSettingsBtn');
    await page.waitForTimeout(500);

    await page.click('[data-tab="planning"]');
    await page.waitForTimeout(300);
    await createDossier(page, 'E2E Couleur GM');
    const card = await dossierCardByName(page, 'E2E Couleur GM');
    const addrInput = card.locator('.address-field textarea').first();
    await addrInput.fill('GM');
    await addrInput.dispatchEvent('input');
    await page.waitForTimeout(200);
    await expect(addrInput).toHaveClass(/addr-gm/);
    const borderColor = await addrInput.evaluate((el) => getComputedStyle(el).borderTopColor);
    expect(borderColor).toBe('rgb(18, 52, 86)'); // #123456
  });
});
