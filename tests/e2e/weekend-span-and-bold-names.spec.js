const { test, expect } = require('@playwright/test');
const { login, createDossier, dossierCardByName } = require('./helpers');

test.describe('Nom des effectifs en gras sur la fiche chantier', () => {
  test("le nom d'un employé assigné s'affiche en gras", async ({ page }) => {
    await login(page);
    const token = await page.evaluate(() => JSON.parse(localStorage.getItem('pe_session_v1')).token);

    const empId = 'e2e-bold-emp';
    await page.evaluate(async ({ empId, token }) => {
      await fetch('/api/employees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Auth-Token': token },
        body: JSON.stringify({ item: { id: empId, name: 'E2E Gras', company: 'Pelichet' } }),
      });
    }, { empId, token });

    await createDossier(page, 'E2E Bold Chip');
    const card = await dossierCardByName(page, 'E2E Bold Chip');
    const id = await card.getAttribute('data-id');
    // Use the dossier's own startDate rather than a freshly computed "today"
    // — the two can disagree by a day if evaluated a beat apart.
    const today = await card.locator('.date-range input').first().inputValue();

    await page.evaluate(async ({ id, today, empId, token }) => {
      await fetch('/api/assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Auth-Token': token },
        body: JSON.stringify({ item: { id: id + '_' + today, dossierId: id, date: today, employees: [{ employeeId: empId }], vehicleIds: [] } }),
      });
    }, { id, today, empId, token });

    await page.reload();
    await page.waitForSelector('#mainApp:not([hidden])', { timeout: 15000 });
    await page.waitForTimeout(500);

    const nameEl = (await dossierCardByName(page, 'E2E Bold Chip')).locator('.chip-emp-name', { hasText: 'E2E Gras' });
    await expect(nameEl).toBeVisible();
    await expect(nameEl).toHaveCSS('font-weight', '700');
  });
});

test.describe('Chantier chevauchant un week-end', () => {
  test("sans « travail le week-end », le chantier n'apparaît pas actif le samedi/dimanche", async ({ page }) => {
    await login(page);
    await createDossier(page, 'E2E Weekend Span');
    const card = await dossierCardByName(page, 'E2E Weekend Span');
    const id = await card.getAttribute('data-id');
    const token = await page.evaluate(() => JSON.parse(localStorage.getItem('pe_session_v1')).token);

    // Monday of the current week through the Monday of the following week —
    // starts one week, finishes the next, crossing exactly one weekend.
    const { startDate, endDate } = await page.evaluate(() => {
      const p = (n) => String(n).padStart(2, '0');
      const fmt = (d) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
      const today = new Date();
      const dow = today.getDay();
      const monday = new Date(today);
      monday.setDate(today.getDate() + (dow === 0 ? -6 : 1 - dow));
      const nextMonday = new Date(monday);
      nextMonday.setDate(monday.getDate() + 7);
      return { startDate: fmt(monday), endDate: fmt(nextMonday) };
    });

    await page.evaluate(async ({ id, startDate, endDate, token }) => {
      await fetch('/api/dossiers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Auth-Token': token },
        body: JSON.stringify({ item: { id, client: 'E2E Weekend Span', startDate, endDate, workWeekends: false } }),
      });
    }, { id, startDate, endDate, token });

    await page.reload();
    await page.waitForSelector('#mainApp:not([hidden])', { timeout: 15000 });
    await page.click('#viewModeWeekBtn');
    await page.waitForTimeout(500);

    const cols = page.locator('.week-day-col');
    await expect(cols.nth(0)).toContainText('E2E Weekend Span'); // Lundi
    await expect(cols.nth(5)).not.toContainText('E2E Weekend Span'); // Samedi
    await expect(cols.nth(6)).not.toContainText('E2E Weekend Span'); // Dimanche
  });
});
