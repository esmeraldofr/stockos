// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('API /api/health', () => {
  test('responds with status ok and metadata', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.ok(), `unexpected status ${res.status()}`).toBeTruthy();

    const body = await res.json();
    expect(body).toMatchObject({ status: 'ok' });
    expect(body).toHaveProperty('v');
    expect(body).toHaveProperty('build');
  });
});
