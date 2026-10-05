const { test, expect } = require('@playwright/test');
const { login, createDossier, dossierCardByName } = require('./helpers');

test.describe('Dashboard : les fenêtres suivent Jour/Semaine/Mois', () => {
  test('le tableau de mobilisation change de colonnes et ajoute un comparatif "l\'an dernier"', async ({ page }) => {
    await login(page);
    await page.click('[data-tab="dashboard"]');
    await page.waitForTimeout(500);

    // Jour : 1 colonne du jour + 1 colonne comparatif.
    await expect(page.locator('#dashWeekTable thead th')).toHaveCount(3); // label vide + jour + comparatif
    await expect(page.locator('#dashWeekTable thead th.week-compare-col')).toContainText("l'an dernier");

    // Semaine : 7 jours + 1 comparatif.
    await page.click('#dashViewWeekBtn');
    await page.waitForTimeout(400);
    await expect(page.locator('#dashWeekTable thead th')).toHaveCount(9);
    await expect(page.locator('#dashWeekTable thead th.week-compare-col')).toContainText('Même semaine');

    // Mois : 1 colonne agrégée + 1 comparatif.
    await page.click('#dashViewMonthBtn');
    await page.waitForTimeout(400);
    await expect(page.locator('#dashWeekTable thead th')).toHaveCount(3);
    await expect(page.locator('#dashWeekTable thead th.week-compare-col')).toContainText('Même mois');
  });

  test('la répartition par type affiche un comparatif par rapport à l\'an dernier', async ({ page }) => {
    await login(page);
    await page.click('[data-tab="dashboard"]');
    await page.waitForTimeout(500);
    await expect(page.locator('#dashTypeDistribution .type-dist-count').first()).toContainText("l'an dernier");
  });

  test('un graphique de suivi du volume par mois est présent', async ({ page }) => {
    await login(page);
    await page.click('[data-tab="dashboard"]');
    await page.waitForTimeout(500);
    await expect(page.locator('#dashChartVolume svg')).toBeVisible();
  });
});

test.describe('Vue Semaine : badges effectif/véhicules assigné vs prévu', () => {
  test('le badge effectif affiche "assigné/prévu"', async ({ page }) => {
    await login(page);
    await page.click('#goTodayBtn');
    await page.waitForTimeout(300);
    await createDossier(page, 'E2E Planifie Vs Assigne');
    const card = await dossierCardByName(page, 'E2E Planifie Vs Assigne');
    await card.locator('input[type=number]').first().fill('4'); // Effectif prévu
    await card.locator('input[type=number]').first().dispatchEvent('change');
    await page.waitForTimeout(300);
    await card.locator('.chips .add-chip').first().click();
    await page.waitForTimeout(300);
    await page.locator('.popover .opt', { hasText: 'PEL-ROSALES Oscar' }).click();
    await page.waitForTimeout(500);

    await page.click('#viewModeWeekBtn');
    await page.waitForTimeout(600);
    await expect(page.locator('.week-day-empcount-item').first()).toContainText('/4 pers.');
  });

  test('sans "prévu" ce jour-là, le badge retombe sur le réel (pas de "/0")', async ({ page }) => {
    await login(page);
    // A date next month, away from "today" (where other tests in this
    // suite leave planned values), so this day's total planned stays 0.
    await page.click('#nextMonth');
    await page.waitForTimeout(300);
    // A weekday, not a weekend — a brand-new dossier defaults to
    // "travail le week-end" off, so one dated on a Sat/Sun wouldn't even
    // show up in its own day's list.
    await page.locator('#calDays .cal-day:not(.other-month):not(.weekend)').first().click();
    await page.waitForTimeout(400);

    await createDossier(page, 'E2E Sans Prevu');
    const card = await dossierCardByName(page, 'E2E Sans Prevu');
    await card.locator('.chips .add-chip').first().click();
    await page.waitForTimeout(300);
    await page.locator('.popover .opt', { hasText: 'PEL-ROSALES Oscar' }).click();
    await page.waitForTimeout(500);

    await page.click('#viewModeWeekBtn');
    await page.waitForTimeout(600);
    const badge = page.locator('.week-day-empcount-item').first();
    await expect(badge).toHaveText(/^\d+ pers\.$/); // plain count, no "/0"
    await expect(badge).not.toContainText('/');
  });
});

test.describe('Impression : numéro d\'ordre du chantier', () => {
  test('la fiche imprimée porte le même numéro que la fiche jour', async ({ page }) => {
    await login(page);
    await page.click('#goTodayBtn');
    await page.waitForTimeout(300);
    await createDossier(page, 'E2E Etiquette Impression');

    const badgeText = await page.evaluate(() => {
      const card = Array.from(document.querySelectorAll('#dossierList .dossier-card')).find(
        (c) => c.querySelector('.client-name').value === 'E2E Etiquette Impression'
      );
      const badge = card.querySelector('.dossier-order-badge');
      return badge ? badge.textContent : null;
    });
    expect(badgeText).toBeTruthy();

    await page.evaluate(() => { window.__printCalled = false; window.print = () => { window.__printCalled = true; }; });
    await page.click('#printDayBtn');
    await page.waitForTimeout(400);
    await expect(page.locator('#printArea .print-card h3', { hasText: 'E2E Etiquette Impression' })).toContainText(badgeText + '.');
  });
});

test.describe('Tableau de disponibilité : largeur de colonne réglable', () => {
  test('glisser la poignée élargit la colonne et la mémorise', async ({ page }) => {
    await login(page);
    await page.waitForTimeout(500);
    const handle = page.locator('#dispoTableHost th.dispo-name-col .dispo-resize-handle').first();
    await expect(handle).toBeVisible();
    await handle.scrollIntoViewIfNeeded();
    const box = await handle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(200);

    const widthVar = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--dispo-name-col-width'));
    expect(parseInt(widthVar, 10)).toBeGreaterThan(200);

    const stored = await page.evaluate(() => localStorage.getItem('pe_dispo_name_col_width_v1'));
    expect(parseInt(stored, 10)).toBeGreaterThan(200);

    await page.reload();
    await page.waitForSelector('#mainApp:not([hidden])', { timeout: 15000 });
    const widthAfterReload = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--dispo-name-col-width'));
    expect(parseInt(widthAfterReload, 10)).toBeGreaterThan(200);
  });
});
