const { test, expect } = require('@playwright/test');
const { login, createDossier, dossierCardByName } = require('./helpers');

test.describe('Dossiers : création, affectation, suppression + annulation', () => {
  test('créer un dossier, lui assigner un employé et un véhicule', async ({ page }) => {
    await login(page);
    await createDossier(page, 'E2E Dossier CRUD');
    const card = await dossierCardByName(page, 'E2E Dossier CRUD');
    expect(card).not.toBeNull();

    await card.locator('.chips .add-chip').first().click();
    await page.waitForTimeout(300);
    await page.locator('.popover .opt', { hasText: 'PEL-RODRIGUES Octavio' }).click();
    await page.waitForTimeout(400);
    await expect(card.locator('.chips').first()).toContainText('PEL-RODRIGUES Octavio');

    const vehChips = card.locator('.chips').nth(1);
    await vehChips.locator('.add-chip').click();
    await page.waitForTimeout(300);
    await page.locator('.popover .opt', { hasText: 'RANGER' }).click();
    await page.waitForTimeout(400);
    await expect(vehChips).toContainText('RANGER');
  });

  test('supprimer un dossier puis annuler la suppression via "Annuler"', async ({ page }) => {
    await login(page);
    await createDossier(page, 'E2E Dossier Suppression');
    let card = await dossierCardByName(page, 'E2E Dossier Suppression');
    expect(card).not.toBeNull();

    const delBtn = card.locator('button', { hasText: 'Supprimer ce dossier' });
    await delBtn.click(); // arm
    await page.waitForTimeout(200);
    await card.locator('button.armed').click(); // confirm
    await page.waitForTimeout(500);

    card = await dossierCardByName(page, 'E2E Dossier Suppression');
    expect(card).toBeNull();

    await page.click('#undoHistoryBtn');
    await page.waitForTimeout(500);
    const row = page.locator('.history-popover .history-row', { hasText: 'E2E Dossier Suppression' }).first();
    await row.locator('button', { hasText: 'Annuler cette action' }).click();
    await page.waitForTimeout(600);

    card = await dossierCardByName(page, 'E2E Dossier Suppression');
    expect(card).not.toBeNull();
  });
});
