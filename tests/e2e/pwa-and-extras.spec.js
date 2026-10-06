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

  test('le menu Détente propose les deux jeux', async ({ page }) => {
    await login(page);
    await page.click('[data-tab="detente"]');
    await page.waitForTimeout(400);
    await expect(page.locator('#detenteMenu')).toBeVisible();
    await expect(page.locator('[data-game="arcade"]')).toBeVisible();
    await expect(page.locator('[data-game="tetris"]')).toBeVisible();
    await expect(page.locator('#detenteArcadeScreen')).toBeHidden();
    await expect(page.locator('#detenteTetrisScreen')).toBeHidden();
  });

  test('le casse-briques se charge avec ses niveaux, briques et HUD', async ({ page }) => {
    await login(page);
    await page.click('[data-tab="detente"]');
    await page.waitForTimeout(400);
    await page.click('[data-game="arcade"]');
    await page.waitForTimeout(600);
    await expect(page.locator('#detenteMenu')).toBeHidden();
    await expect(page.locator('#arcLevel')).toHaveText('1');
    await expect(page.locator('#arcScore')).toHaveText('0');
    await expect(page.locator('#arcLives')).toHaveText('3');
    await expect(page.locator('#arcCanvas')).toBeVisible();

    await page.click('#arcBackBtn');
    await page.waitForTimeout(200);
    await expect(page.locator('#detenteMenu')).toBeVisible();
  });

  test('Tetris se charge avec sa grille, la pièce suivante et son HUD', async ({ page }) => {
    await login(page);
    await page.click('[data-tab="detente"]');
    await page.waitForTimeout(400);
    await page.click('[data-game="tetris"]');
    await page.waitForTimeout(600);
    await expect(page.locator('#detenteMenu')).toBeHidden();
    await expect(page.locator('#tetrisLevel')).toHaveText('1');
    await expect(page.locator('#tetrisScore')).toHaveText('0');
    await expect(page.locator('#tetrisLines')).toHaveText('0');
    await expect(page.locator('#tetrisCanvas')).toBeVisible();
    await expect(page.locator('#tetrisNextCanvas')).toBeVisible();

    // Moving and rotating the falling piece shouldn't throw or freeze the loop.
    await page.locator('#tetrisCanvas').click();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(300);
    await expect(page.locator('#tetrisCanvas')).toBeVisible();

    // The on-screen touch controls (mobile) work the same way.
    await page.click('#tetrisBtnRotate');
    await page.click('#tetrisBtnDown');
    await page.waitForTimeout(200);

    await page.click('#tetrisBackBtn');
    await page.waitForTimeout(200);
    await expect(page.locator('#detenteMenu')).toBeVisible();
  });

  test('Tetris : une chute forcée verrouille la pièce et relance le jeu sans erreur', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(String(err)));
    await login(page);
    await page.click('[data-tab="detente"]');
    await page.waitForTimeout(400);
    await page.click('[data-game="tetris"]');
    await page.waitForTimeout(400);
    // Hard-drop several times in a row — enough to lock multiple pieces
    // and exercise line-clear / next-piece-spawn without crashing.
    for (let i = 0; i < 15; i++) {
      await page.click('#tetrisBtnDrop');
      await page.waitForTimeout(80);
    }
    await page.waitForTimeout(300);
    expect(errors).toEqual([]);
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
