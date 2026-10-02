const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

test.describe('PWA', () => {
  test('le manifest est valide et le service worker s\'enregistre', async ({ page }) => {
    await login(page);
    await page.waitForTimeout(1000);

    const manifest = await page.evaluate(async () => {
      const link = document.querySelector('link[rel="manifest"]');
      const res = await fetch(link.href);
      return res.json();
    });
    expect(manifest.icons.length).toBeGreaterThanOrEqual(2);
    expect(manifest.display).toBe('standalone');

    await page.waitForTimeout(1000);
    const sw = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return reg && reg.active ? reg.active.state : null;
    });
    expect(sw).toBe('activated');
  });
});

test.describe('Zen Attitude et Détente', () => {
  test('la respiration guidée démarre et change de phase', async ({ page }) => {
    await login(page);
    await page.click('[data-tab="zen"]');
    await page.waitForTimeout(300);
    await page.click('#zenStartBtn');
    await page.waitForTimeout(300);
    await expect(page.locator('#zenPhaseLabel')).toHaveText('Inspirez');
    await page.click('#zenStartBtn');
  });

  test('le casse-briques se charge avec ses briques et son HUD', async ({ page }) => {
    await login(page);
    await page.click('[data-tab="detente"]');
    await page.waitForTimeout(600);
    await expect(page.locator('#arcScore')).toHaveText('0');
    await expect(page.locator('#arcLives')).toHaveText('3');
    await expect(page.locator('#arcCanvas')).toBeVisible();
  });
});

test.describe('Admin : historique complet', () => {
  test('la liste complète des actions se charge et peut être filtrée', async ({ page }) => {
    await login(page);
    await page.click('[data-tab="admin"]');
    await page.waitForTimeout(800);
    await expect(page.locator('#fullActionLogList .history-row').first()).toBeVisible();

    await page.fill('#fullActionLogSearch', 'zzz-ne-correspond-a-rien-zzz');
    await page.waitForTimeout(300);
    await expect(page.locator('#fullActionLogList')).toContainText('Aucune action ne correspond');
  });
});
