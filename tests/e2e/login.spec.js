// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('Login screen', () => {
  test.beforeEach(async ({ context }) => {
    // Ensure no leftover session from a previous run forces redirect away from login.
    await context.clearCookies();
    await context.addInitScript(() => {
      try { localStorage.clear(); } catch (_) {}
    });
  });

  test('renders the StockOS login form', async ({ page }) => {
    await page.goto('/');

    await expect(page).toHaveTitle(/StockOS/i);

    await expect(page.locator('#login-screen')).toBeVisible();
    await expect(page.locator('#l-login')).toBeVisible();
    await expect(page.locator('#l-pass')).toBeVisible();
    await expect(page.getByRole('button', { name: /entrar/i })).toBeVisible();
  });

  test('rejects empty credentials with a validation message', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: /entrar/i }).click();

    // The API returns 400 with this message when fields are missing,
    // and the UI surfaces it inside #login-msg.
    await expect(page.locator('#login-msg')).toContainText(
      /nome de utilizador e senha/i,
      { timeout: 10_000 }
    );
  });
});
