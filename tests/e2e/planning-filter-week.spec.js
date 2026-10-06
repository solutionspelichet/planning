const { test, expect } = require('@playwright/test');
const { login, createDossier, dossierCardByName } = require('./helpers');

// The move-type selector lives in the card's header (select.dossier-slot-header),
// not in an .info-field with its own label.
async function setMoveType(page, cardName, type) {
  const card = await dossierCardByName(page, cardName);
  await page.evaluate(
    ({ id, type }) => {
      const card = document.querySelector(`.dossier-card[data-id="${id}"]`);
      const sel = card.querySelector('select.dossier-slot-header');
      sel.value = type;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    },
    { id: await card.getAttribute('data-id'), type }
  );
  await page.waitForTimeout(400);
}

test.describe('Filtre de type et vue semaine', () => {
  test('le filtre masque les chantiers des autres types et affiche un compteur', async ({ page }) => {
    await login(page);
    await createDossier(page, 'E2E Filtre NL');
    await setMoveType(page, 'E2E Filtre NL', 'NL');

    const nlChip = page.locator('#planningFilterBar .filter-chip', { hasText: 'NL' });
    await expect(nlChip).toContainText('NL (1)');
    await nlChip.click();
    await page.waitForTimeout(300);

    const visibleNames = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#dossierList .client-name')).map((i) => i.value)
    );
    expect(visibleNames).toEqual(['E2E Filtre NL']);

    await page.locator('#planningFilterBar .filter-chip', { hasText: 'Réinitialiser' }).click();
  });

  test('la vue semaine affiche 7 colonnes et le filtre y fonctionne aussi', async ({ page }) => {
    await login(page);
    await page.click('#viewModeWeekBtn');
    await page.waitForTimeout(400);
    await expect(page.locator('#weekGrid .week-day-col')).toHaveCount(7);
    await page.click('#viewModeDayBtn');
  });
});

test.describe('Résolution rapide des conflits', () => {
  test('un bouton "Retirer de" apparaît en cas de double réservation et résout le conflit', async ({ page }) => {
    await login(page);
    await createDossier(page, 'E2E Conflit A');
    await createDossier(page, 'E2E Conflit B');

    // Uses an employee no other spec file touches: tests share one server/DB
    // for the whole run (all on the same default date), so reusing an
    // employee booked elsewhere would create a 3-way conflict that removing
    // one booking can't resolve. (PEL-CORAZZOL Christophe is also used by
    // absence-conflicts.spec.js on the same default day — that collision
    // intermittently left a second, unrelated conflict row for the same
    // name in the banner, which this test then mistook for its own.)
    for (const name of ['E2E Conflit A', 'E2E Conflit B']) {
      const card = await dossierCardByName(page, name);
      await card.locator('.chips .add-chip').first().click();
      await page.waitForTimeout(300);
      await page.locator('.popover .opt', { hasText: 'PEL-MARTINEZ Damien' }).click();
      await page.waitForTimeout(400);
    }

    const banner = page.locator('#conflictBanner .conflict-banner');
    await expect(banner).toContainText('Double réservation');
    await expect(banner).toContainText('PEL-MARTINEZ Damien');

    // "Retirer de" round-trips a POST /api/assignments then a full
    // refreshAll() (GET /api/all) before the banner re-renders — under load
    // that's slower than a short fixed wait, so wait for the save response
    // itself rather than guessing a delay, then let the assertion's own
    // retry window (not a fixed sleep) catch the re-render.
    const fixChip = banner.locator('.conflict-fix-chip', { hasText: 'E2E Conflit B' });
    const removeSaved = page.waitForResponse((r) => r.url().includes('/api/assignments') && r.request().method() === 'POST');
    await fixChip.click();
    await removeSaved;

    // Other tests in this shared-server run may book their own resources
    // (e.g. a vehicle) twice on the same default day, so the banner can
    // legitimately still show an unrelated conflict row — check only that
    // *this* conflict (Damien, double-booked on A and B) is gone, rather
    // than asserting the whole banner disappeared.
    await expect(page.locator('#conflictBanner')).not.toContainText('PEL-MARTINEZ Damien', { timeout: 10000 });
  });
});
