// @ts-check
const { test, expect } = require('@playwright/test');

const E2E_USER = process.env.E2E_USER || 'admin';
const E2E_PASS = process.env.E2E_PASS || 'admin123';

test.describe('Authenticated flow', () => {
  // Cold starts (Vercel + Supabase) can take a while; give the auth flow extra time.
  test.setTimeout(120_000);

  // Warm up the deployment so cold-start latency doesn't blow up the UI tests
  // running in parallel below. A first call to /api/auth/login on a cold Vercel
  // function + Supabase pool can easily take >30s.
  test.beforeAll({ timeout: 180_000 }, async ({ request }) => {
    try {
      await request.get('/api/health');
      await request.post('/api/auth/login', {
        data: { login: E2E_USER, password: E2E_PASS },
        timeout: 120_000,
      });
    } catch (_) {
      // Ignore — the actual tests will surface any real failure.
    }
  });

  test.beforeEach(async ({ context }) => {
    await context.clearCookies();
    await context.addInitScript(() => {
      try { localStorage.clear(); } catch (_) {}
    });
  });

  /** Submit the login form and wait for the auth response to come back. */
  async function submitLogin(page) {
    const loginResponse = page.waitForResponse(
      (r) => r.url().endsWith('/api/auth/login') && r.request().method() === 'POST',
      { timeout: 60_000 }
    );
    await page.locator('#l-login').fill(E2E_USER);
    await page.locator('#l-pass').fill(E2E_PASS);
    await page.getByRole('button', { name: /entrar/i }).click();
    const res = await loginResponse;
    expect(res.ok(), `login API returned ${res.status()}: ${await res.text()}`).toBeTruthy();
  }

  test('POST /api/auth/login returns a token and the user payload', async ({ request }) => {
    const res = await request.post('/api/auth/login', {
      data: { login: E2E_USER, password: E2E_PASS },
    });

    expect(res.ok(), `unexpected status ${res.status()} — body: ${await res.text()}`).toBeTruthy();

    const body = await res.json();
    expect(body).toHaveProperty('token');
    expect(typeof body.token).toBe('string');
    expect(body.token.length).toBeGreaterThan(10);
    expect(body.user).toMatchObject({ role: expect.any(String) });
  });

  test('UI login lands on the Dia page with navbar visible', async ({ page }) => {
    await page.goto('/');
    await submitLogin(page);

    // Login screen should be replaced by the Dia view (with the navbar).
    await expect(page.locator('#login-screen')).toHaveCount(0, { timeout: 60_000 });
    await expect(page.locator('#navbar')).toBeVisible({ timeout: 60_000 });

    // The "Dia" tab is the default landing page and should be marked active.
    const diaTab = page.locator('#navbar .nav-btn.active', { hasText: /dia/i });
    await expect(diaTab).toBeVisible();

    // Token persisted to localStorage so refresh keeps the session alive.
    const token = await page.evaluate(() => localStorage.getItem('token'));
    expect(token, 'expected JWT token in localStorage after login').toBeTruthy();
  });

  test('logout returns the user to the login screen', async ({ page }) => {
    await page.goto('/');
    await submitLogin(page);

    await expect(page.locator('#navbar')).toBeVisible({ timeout: 60_000 });

    await page.locator('#navbar .nav-btn', { hasText: /sair/i }).click();

    await expect(page.locator('#login-screen')).toBeVisible({ timeout: 10_000 });
    const token = await page.evaluate(() => localStorage.getItem('token'));
    expect(token).toBeNull();
  });
});
