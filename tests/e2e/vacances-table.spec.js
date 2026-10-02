const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

test.describe('Vacances & Garage : tableau Gantt du mois + exports', () => {
  // The suite's spec files share one server/database for the whole run, so
  // other files may already have added absences/downtimes this month by the
  // time this runs — this only checks that OUR entry shows up correctly,
  // not that the table starts empty.
  test('une personne avec une absence ce mois-ci apparaît dans le tableau, sur les bons jours', async ({ page }) => {
    await login(page);
    await page.click('[data-tab="vacances"]');
    await page.waitForTimeout(400);

    await page.evaluate(() => {
      const sel = document.getElementById('newAbsenceEmp');
      const opt = Array.from(sel.options).find((o) => o.textContent === 'PEL-ADLI Mongi');
      sel.value = opt.value;
      document.getElementById('newAbsenceReason').value = 'Congés';
      document.getElementById('newAbsenceStart').value = '2026-10-10';
      document.getElementById('newAbsenceEnd').value = '2026-10-12';
    });
    await page.click('#addAbsenceBtn');
    await page.waitForTimeout(600);

    const table = page.locator('#vacAvailabilityHost table.dispo');
    await expect(table).toBeVisible();
    const row = table.locator('tbody tr', { hasText: 'PEL-ADLI Mongi' });
    await expect(row).toBeVisible();
    await expect(row.locator('td.dispo-cell').nth(9).locator('.dispo-swatch')).toHaveCount(1); // day 10
    await expect(row.locator('td.dispo-cell').nth(12).locator('.dispo-swatch')).toHaveCount(0); // day 13, not absent
  });

  test('export CSV du tableau Vacances & Garage', async ({ page }) => {
    await login(page);
    await page.click('[data-tab="vacances"]');
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      document.getElementById('newAbsenceEmp').selectedIndex = 0;
      document.getElementById('newAbsenceReason').value = 'Maladie';
      document.getElementById('newAbsenceStart').value = '2026-10-15';
      document.getElementById('newAbsenceEnd').value = '2026-10-15';
    });
    await page.click('#addAbsenceBtn');
    await page.waitForTimeout(600);

    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#exportVacCsvBtn')]);
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    expect(text.split('\r\n')[0]).toContain('Nom / Véhicule');
    expect(text).toContain('Maladie');
  });

  test('export PDF du tableau Vacances & Garage', async ({ page }) => {
    await login(page);
    await page.click('[data-tab="vacances"]');
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      document.getElementById('newDowntimeVeh').selectedIndex = 0;
      document.getElementById('newDowntimeReason').value = 'Entretien';
      document.getElementById('newDowntimeStart').value = '2026-10-20';
      document.getElementById('newDowntimeEnd').value = '2026-10-20';
    });
    await page.click('#addDowntimeBtn');
    await page.waitForTimeout(600);

    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#exportVacPdfBtn')]);
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const buf = Buffer.concat(chunks);
    expect(buf.slice(0, 5).toString('latin1')).toBe('%PDF-');
  });
});
