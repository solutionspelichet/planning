const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

// Guards against horizontal page overflow on a phone-width viewport — found
// via manual audit: the Dashboard's per-day filter buttons didn't wrap, the
// weekly table wasn't in a scrollable wrapper, and the Vacances & Garage
// cards had a fixed 420px minimum that didn't fit a 390px screen.
test.describe('Pas de débordement horizontal de la page sur mobile (390px)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  async function assertNoPageOverflow(page) {
    const { docW, scrollW } = await page.evaluate(() => ({
      docW: document.documentElement.clientWidth,
      scrollW: document.documentElement.scrollWidth,
    }));
    expect(scrollW).toBeLessThanOrEqual(docW + 2);
  }

  test('Dashboard', async ({ page }) => {
    await login(page);
    await page.click('[data-tab="dashboard"]');
    await page.waitForTimeout(700);
    await assertNoPageOverflow(page);
  });

  test('Vacances & Garage', async ({ page }) => {
    await login(page);
    await page.click('[data-tab="vacances"]');
    await page.waitForTimeout(500);
    await assertNoPageOverflow(page);
  });

  test('Planning (jour et semaine)', async ({ page }) => {
    await login(page);
    await assertNoPageOverflow(page);
    await page.click('#viewModeWeekBtn');
    await page.waitForTimeout(500);
    await assertNoPageOverflow(page);
  });
});
