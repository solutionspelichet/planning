const { test, expect } = require('@playwright/test');
const path = require('path');
const { login } = require('./helpers');

// Uses a tiny synthetic fixture (no real business data) shaped like the
// legacy Excel planning this import reads: one EFFECTIFS roster row, one
// vehicle, one day with one chantier. See lib/legacyImport.js for the
// format this is meant to exercise.
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'legacy-planning-sample.xlsx');

test.describe("Import de l'ancien planning Excel", () => {
  test('analyse puis import crée l\'employé, le véhicule et le dossier attendus', async ({ page }) => {
    await login(page); // seeded test user is an admin
    await page.click('#adminTabBtn');
    await page.waitForSelector('#legacyImportFileInput', { timeout: 10000 });

    await page.setInputFiles('#legacyImportFileInput', FIXTURE);
    await page.click('#legacyImportAnalyzeBtn');
    await page.waitForSelector('#legacyImportCommitBtn', { timeout: 15000 });

    const summaryText = await page.locator('#legacyImportSummary').innerText();
    expect(summaryText).toContain('1 employé(s) à créer');
    expect(summaryText).toContain('1 véhicule(s) à créer');
    expect(summaryText).toContain('1 dossier(s) à créer (1 affectations)');

    page.once('dialog', (d) => d.accept());
    await page.click('#legacyImportCommitBtn');
    await page.waitForTimeout(1500);

    const token = await page.evaluate(() => JSON.parse(localStorage.getItem('pe_session_v1')).token);
    const all = await page.evaluate(async (token) => {
      const r = await fetch('/api/all', { headers: { 'X-Auth-Token': token } });
      return r.json();
    }, token);

    expect(all.employees.some((e) => e.name === 'PEL-TESTEUR Alice')).toBe(true);
    expect(all.vehicles.some((v) => v.name === '901')).toBe(true);
    const dossier = all.dossiers.find((d) => d.dossierNumber === 'TEST-0001');
    expect(dossier).toBeTruthy();
    expect(dossier.client).toBe('CLIENT FIXTURE');
    expect(dossier.startDate).toBe('2026-01-05');
    expect(dossier.endDate).toBe('2026-01-05');
  });

  test('un second import du même fichier ne duplique pas le dossier numéroté', async ({ page }) => {
    await login(page);
    await page.click('#adminTabBtn');
    await page.waitForSelector('#legacyImportFileInput', { timeout: 10000 });

    await page.setInputFiles('#legacyImportFileInput', FIXTURE);
    await page.click('#legacyImportAnalyzeBtn');
    await page.waitForSelector('#legacyImportCommitBtn', { timeout: 15000 });

    const summaryText = await page.locator('#legacyImportSummary').innerText();
    // Everything from the first test's run already exists, by name/number.
    expect(summaryText).toContain('0 employé(s) à créer');
    expect(summaryText).toContain('0 véhicule(s) à créer');
    expect(summaryText).toContain('0 dossier(s) à créer');
    expect(summaryText).toContain('1 dossier(s) déjà présents, ignorés');
  });

  test("Annuler un import précédent efface exactement ce qu'il a créé", async ({ page }) => {
    await login(page);
    await page.click('#adminTabBtn');
    await page.waitForSelector('#legacyImportBatches .emp-list li', { timeout: 10000 });

    // The first test's batch is the only one that actually created
    // anything (the second test's re-import created nothing) — find it by
    // its distinctive counts rather than by position in the list.
    const row = page.locator('#legacyImportBatches li', { hasText: '1 dossier(s), 1 employé(s), 1 véhicule(s)' });
    await expect(row).toBeVisible();

    const token = await page.evaluate(() => JSON.parse(localStorage.getItem('pe_session_v1')).token);
    const before = await page.evaluate(async (token) => {
      const r = await fetch('/api/all', { headers: { 'X-Auth-Token': token } });
      return r.json();
    }, token);
    expect(before.dossiers.some((d) => d.dossierNumber === 'TEST-0001')).toBe(true);

    page.once('dialog', (d) => d.accept());
    await row.locator('[data-undo-batch]').click();
    await page.waitForTimeout(1000);

    await expect(row).toContainText('(annulé)');

    const after = await page.evaluate(async (token) => {
      const r = await fetch('/api/all', { headers: { 'X-Auth-Token': token } });
      return r.json();
    }, token);
    expect(after.employees.some((e) => e.name === 'PEL-TESTEUR Alice')).toBe(false);
    expect(after.vehicles.some((v) => v.name === '901')).toBe(false);
    expect(after.dossiers.some((d) => d.dossierNumber === 'TEST-0001')).toBe(false);
  });
});
