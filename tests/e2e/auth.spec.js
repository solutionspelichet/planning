const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

test.describe('Authentification', () => {
  test('connexion avec des identifiants valides', async ({ page }) => {
    await login(page);
    await expect(page.locator('#mainApp')).toBeVisible();
    await expect(page.locator('#whoName')).toHaveText('test');
  });

  test('refuse un mauvais mot de passe', async ({ page }) => {
    await page.goto('/');
    await page.fill('#loginUser', 'test');
    await page.fill('#loginPass', 'mauvais-mot-de-passe');
    await page.click('#loginBtn');
    await page.waitForTimeout(500);
    await expect(page.locator('#mainApp')).toBeHidden();
    await expect(page.locator('#loginError')).not.toHaveText('');
  });

  // Uses a username that doesn't exist, never "test" (the account every
  // other spec file's login() helper depends on) — the lockout is per
  // username, so this can't lock the suite out of its own admin account.
  test('bloque les tentatives après 5 échecs sur le même compte', async ({ page }) => {
    await page.goto('/');
    for (let i = 0; i < 5; i++) {
      await page.fill('#loginUser', 'ratelimit-test-user');
      await page.fill('#loginPass', 'wrong-' + i);
      await page.click('#loginBtn');
      await page.waitForTimeout(300);
    }
    await page.fill('#loginUser', 'ratelimit-test-user');
    await page.fill('#loginPass', 'wrong-6th-try');
    await page.click('#loginBtn');
    await page.waitForTimeout(300);
    await expect(page.locator('#loginError')).toContainText('Trop de tentatives');
  });
});
