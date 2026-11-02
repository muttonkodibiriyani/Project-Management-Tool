import { expect, test } from '../fixtures.js';

test('the browser uses the common work-account sign-in and sign-out flow', async ({ page }) => {
  await page.goto('/#login');
  await expect(page.getByRole('heading', { level: 1, name: 'Welcome back' })).toBeVisible();
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(page.getByText(/Google|Apple|Forgot password|Sign up/i)).toHaveCount(0);

  await page.getByRole('button', { name: 'Continue with Microsoft' }).click();
  await expect(page).toHaveURL(/\/auth\/dev-login\?returnTo=%2F$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Test sign-in' })).toBeVisible();
  await expect(page.getByRole('link')).toHaveCount(7);

  await page.getByRole('link', { name: /Ada Admin/ }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  await page.evaluate(() => {
    localStorage.setItem('lt.cache.active', 'synthetic-pointer');
    localStorage.setItem('lt.cache.v1:synthetic-user:synthetic-workspace', 'synthetic-cache');
    localStorage.setItem('gr8r.v2', 'synthetic-legacy-cache');
  });
  let logoutCall: { method: string; data: unknown } | undefined;
  await page.route('**/auth/logout', async route => {
    const response = await route.fetch();
    const body = await response.body();
    logoutCall = { method: route.request().method(), data: JSON.parse(body.toString()) as unknown };
    await route.fulfill({ response, body });
  });
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect.poll(() => logoutCall).toEqual({ method: 'POST', data: { logoutUrl: '/auth/login' } });

  await expect(page).toHaveURL(/\/auth\/dev-login\?returnTo=%2F$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Test sign-in' })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => [
        localStorage.getItem('lt.cache.active'),
        localStorage.getItem('lt.cache.v1:synthetic-user:synthetic-workspace'),
        localStorage.getItem('gr8r.v2'),
      ]),
    )
    .toEqual([null, null, null]);
});
