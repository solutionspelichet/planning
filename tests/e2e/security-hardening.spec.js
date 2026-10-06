const { test, expect } = require('@playwright/test');

test.describe('Durcissement backend', () => {
  test('les en-têtes de sécurité de base sont présents', async ({ request }) => {
    const res = await request.get('/api/health');
    const headers = res.headers();
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  test('un corps JSON malformé est rejeté proprement (400 JSON, pas de stack trace HTML)', async ({ request }) => {
    const res = await request.post('/api/login', {
      headers: { 'Content-Type': 'application/json' },
      data: '{not valid json',
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    const text = await (await request.post('/api/login', {
      headers: { 'Content-Type': 'application/json' },
      data: '{not valid json',
    })).text();
    expect(text).not.toContain('<pre>'); // Express's default HTML error page includes the stack in a <pre>
  });
});
