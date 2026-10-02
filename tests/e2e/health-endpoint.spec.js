const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

test.describe('Point de santé pour la surveillance externe', () => {
  test('/api/health répond sans authentification avec des signaux infra', async ({ page, request }) => {
    const res = await request.get('/api/health');
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.serverTime).toBe('number');
    // diskFreePercent is either a number (statfsSync supported) or null
    // (unsupported platform) — either is a valid, non-crashing response.
    expect(body).toHaveProperty('diskFreePercent');
    expect(body).toHaveProperty('driveSyncStatus');
  });

  test("l'onglet Admin affiche l'espace disque disponible", async ({ page }) => {
    await login(page);
    await page.click('[data-tab="admin"]');
    await page.waitForTimeout(600);
    await expect(page.locator('#diskStatus')).toContainText('Espace disque');
  });
});
