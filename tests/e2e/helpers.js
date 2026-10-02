async function login(page, { username = 'test', password = 'test1234' } = {}) {
  await page.goto('/');
  await page.fill('#loginUser', username);
  await page.fill('#loginPass', password);
  await page.click('#loginBtn');
  await page.waitForSelector('#mainApp:not([hidden])', { timeout: 15000 });
  await page.waitForTimeout(500);
}

async function createDossier(page, name) {
  await page.click('#newDossierBtn');
  await page.waitForTimeout(400);
  await page.evaluate((name) => {
    const card = document.querySelector('#dossierList .dossier-card:last-child');
    card.querySelector('.client-name').value = name;
    card.querySelector('.client-name').dispatchEvent(new Event('change', { bubbles: true }));
  }, name);
  await page.waitForTimeout(400);
}

// Input values set via JS (not the HTML `value` attribute) aren't matched
// by CSS attribute selectors, so we resolve the card's data-id in the page
// first and hand back a plain locator for it.
async function dossierCardByName(page, name) {
  const id = await page.evaluate((name) => {
    const card = Array.from(document.querySelectorAll('#dossierList .dossier-card')).find(
      (c) => c.querySelector('.client-name').value === name
    );
    return card ? card.dataset.id : null;
  }, name);
  if (!id) return null;
  return page.locator(`.dossier-card[data-id="${id}"]`);
}

module.exports = { login, createDossier, dossierCardByName };
