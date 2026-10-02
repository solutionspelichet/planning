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
});
