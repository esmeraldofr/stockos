const { test, expect } = require('@playwright/test');

test.describe('StockOS — smoke', () => {
  test('homepage carrega e mostra o ecrã de login', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/StockOS/i);
    await expect(page.locator('#login-screen')).toBeVisible();
    await expect(page.locator('#l-login')).toBeVisible();
    await expect(page.locator('#l-pass')).toBeVisible();
  });

  test('login com credenciais inválidas mostra mensagem de erro', async ({ page }) => {
    await page.goto('/');
    await page.locator('#l-login').fill('admin');
    await page.locator('#l-pass').fill('password-errada');
    await page.getByRole('button', { name: 'Entrar' }).click();
    await expect(page.locator('#login-msg')).not.toBeEmpty({ timeout: 10_000 });
  });
});

test.describe('StockOS — autenticação admin', () => {
  test('login admin esconde o ecrã de login', async ({ page }) => {
    await page.goto('/');
    await page.locator('#l-login').fill('admin');
    await page.locator('#l-pass').fill('admin123');
    await page.getByRole('button', { name: 'Entrar' }).click();
    await expect(page.locator('#login-screen')).toBeHidden({ timeout: 15_000 });
  });
});

test.describe('StockOS — API', () => {
  test('POST /api/auth/login devolve token para admin', async ({ request }) => {
    const res = await request.post('/api/auth/login', {
      data: { login: 'admin', password: 'admin123' },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.token).toBeTruthy();
    expect(body.user?.role).toBe('admin');
  });

  test('POST /api/auth/login rejeita credenciais inválidas', async ({ request }) => {
    const res = await request.post('/api/auth/login', {
      data: { login: 'admin', password: 'errada' },
    });
    expect(res.status()).toBe(401);
  });
});
