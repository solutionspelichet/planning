const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

test.describe('Exports CSV et PDF', () => {
  test('export CSV télécharge un fichier avec un en-tête valide', async ({ page }) => {
    await login(page);
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#exportCsvBtn')]);
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    expect(text.split('\r\n')[0]).toContain('Date;Jour;Créneau;Type');
  });

  test('export PDF télécharge un fichier PDF valide', async ({ page }) => {
    await login(page);
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#exportPdfBtn')]);
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const buf = Buffer.concat(chunks);
    expect(buf.slice(0, 5).toString('latin1')).toBe('%PDF-');
  });
});
