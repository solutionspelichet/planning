const { test, expect } = require('@playwright/test');
const { login, createDossier, dossierCardByName } = require('./helpers');

test.describe('Historique de dossier et alerte de capacité', () => {
  test('le bouton Historique liste les modifications du dossier', async ({ page }) => {
    await login(page);
    await createDossier(page, 'E2E Historique');
    let card = await dossierCardByName(page, 'E2E Historique');
    await page.evaluate((id) => {
      const card = document.querySelector(`.dossier-card[data-id="${id}"]`);
      const input = card.querySelector('.client-name');
      input.value = 'E2E Historique Renomme';
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, await card.getAttribute('data-id'));
    await page.waitForTimeout(500);

    card = await dossierCardByName(page, 'E2E Historique Renomme');
    await card.locator('button.history-btn', { hasText: 'Historique' }).click();
    await page.waitForTimeout(500);
    await expect(page.locator('.history-popover')).toContainText('E2E Historique Renomme');
  });

  test('une alerte apparaît quand le volume dépasse la capacité du véhicule assigné', async ({ page }) => {
    await login(page);

    await page.click('[data-tab="vehicules"]');
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll('#vehicleGrid .emp-row')).find(
        (r) => r.querySelector('.emp-name').textContent.trim() === 'RANGER'
      );
      const input = row.querySelector('.veh-capacity-input');
      input.value = '5';
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(400);

    await page.click('[data-tab="planning"]');
    await page.waitForTimeout(400);
    await createDossier(page, 'E2E Capacite');
    const card = await dossierCardByName(page, 'E2E Capacite');
    const id = await card.getAttribute('data-id');

    await page.evaluate((id) => {
      const card = document.querySelector(`.dossier-card[data-id="${id}"]`);
      const field = Array.from(card.querySelectorAll('.info-field')).find(
        (f) => f.querySelector('label') && f.querySelector('label').textContent.indexOf('Volume') !== -1
      );
      const input = field.querySelector('input');
      input.value = '12';
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, id);
    await page.waitForTimeout(400);

    const vehChips = card.locator('.chips').nth(1);
    await vehChips.locator('.add-chip').click();
    await page.waitForTimeout(300);
    await page.locator('.popover .opt', { hasText: 'RANGER' }).click();
    await page.waitForTimeout(500);

    await expect(card.locator('.capacity-warning')).toContainText('capacité des véhicules assignés');
  });
});
