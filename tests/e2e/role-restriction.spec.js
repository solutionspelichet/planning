const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

test.describe('Rôle "user" : navigation restreinte à Planning', () => {
  test('ne voit que l\'onglet Planning, le calendrier principal et Aujourd\'hui/Jour/Semaine/Imprimer', async ({ page, browser }) => {
    // Create a read-only account through the seeded admin session, then log
    // into it from a fresh context — the admin's own session must stay
    // untouched for every other spec file sharing this server.
    await login(page);
    const token = await page.evaluate(() => JSON.parse(localStorage.getItem('pe_session_v1')).token);
    await page.evaluate(async (token) => {
      await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Auth-Token': token },
        body: JSON.stringify({ username: 'e2e-readonly', password: 'readonly1234', role: 'user' }),
      });
    }, token);

    const userContext = await browser.newContext();
    const userPage = await userContext.newPage();
    await userPage.goto('/');
    await userPage.fill('#loginUser', 'e2e-readonly');
    await userPage.fill('#loginPass', 'readonly1234');
    await userPage.click('#loginBtn');
    await userPage.waitForSelector('#mainApp:not([hidden])', { timeout: 15000 });
    await userPage.waitForTimeout(500);

    const visibleTabs = await userPage.$$eval('.tab-btn', (els) => els.filter((e) => e.offsetParent !== null).map((e) => e.textContent.trim()));
    expect(visibleTabs).toEqual(['Planning']);

    const visibleCalendars = await userPage.$$eval('.calendar-stack .calendar', (els) =>
      els.filter((e) => e.offsetParent !== null).map((e) => e.querySelector('h3')?.textContent.trim())
    );
    expect(visibleCalendars).toEqual(['Planning']);

    const visibleActions = await userPage.$$eval('.day-panel-actions > *', (els) =>
      els.filter((e) => e.offsetParent !== null).map((e) => e.textContent.replace(/\s+/g, ' ').trim())
    );
    expect(visibleActions).toEqual(["📅 Aujourd'hui", 'Jour Semaine', '🖨 Imprimer']);

    // The hidden tab buttons are still in the DOM (CSS-hidden, not
    // removed) — a raw DOM .click() bypasses Playwright's visibility
    // checks the same way a console call would, exercising setTab()'s own
    // role guard rather than just the CSS that keeps the button unclickable
    // in the real UI.
    const stayedOnPlanning = await userPage.evaluate(() => {
      document.querySelector('[data-tab="dashboard"]').click();
      return document.querySelector('.tab-btn.active')?.dataset.tab === 'planning' && document.getElementById('view-dashboard').hidden;
    });
    expect(stayedOnPlanning).toBe(true);

    await userContext.close();
  });
});
