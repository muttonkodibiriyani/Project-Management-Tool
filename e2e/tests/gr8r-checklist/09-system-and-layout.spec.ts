// Spec section 2: design-system page; error, offline and empty states; responsive layout.
import type { Page } from '@playwright/test';
import { expect, openFromSidebar, sidebar, test } from '../fixtures.js';

/** Runs one item from the sidebar's Help & resources menu. */
async function help(page: Page, item: string): Promise<void> {
  await sidebar(page).getByRole('button', { name: 'Help & resources' }).click();
  await page.getByRole('menu').getByRole('button', { name: item }).click();
}

test('the design-system page shows the tokens and components', async ({ app: page }) => {
  await help(page, 'Design system');
  await expect(page.getByRole('heading', { level: 1, name: 'Design system' })).toBeVisible();
  const main = page.getByRole('main');
  for (const section of [/^Color/, 'Inputs', 'Navigation', 'Data display', 'Feedback']) {
    await expect(main.getByRole('heading', { level: 2, name: section })).toBeVisible();
  }
  // The page switches themes so both palettes can be compared.
  await main.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('system states show the empty, loading and error patterns', async ({ app: page }) => {
  await help(page, 'System states');
  const main = page.getByRole('main');
  await expect(page.getByRole('heading', { level: 1, name: 'System states' })).toBeVisible();
  await expect(main.getByRole('heading', { name: "You're offline" })).toBeVisible();
  await expect(main.getByRole('heading', { name: "You're all caught up." })).toBeVisible();
});

test('offline mode warns, refuses to save and recovers', async ({ app: page }) => {
  await help(page, 'Simulate offline');
  const banner = page.getByRole('alert').filter({ hasText: "You're offline." });
  await expect(banner).toBeVisible();

  await openFromSidebar(page, 'My Tasks 2', 'My Tasks');
  await page.getByRole('table', { name: 'Tasks' }).getByRole('checkbox', { name: 'Mark Prepare design system tokens complete' }).click();
  await expect(page.getByText("Your changes couldn't be saved. You're offline.")).toBeVisible();
  await expect(page.getByRole('table', { name: 'Tasks' }).getByRole('checkbox', { name: 'Mark Prepare design system tokens complete' })).toBeVisible();

  await help(page, 'Go back online');
  await expect(banner).toBeHidden();
});

test('a broken link shows the not-found page with a way back', async ({ app: page }) => {
  await help(page, 'Open a broken link');
  await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
  await expect(page.getByText('ERROR 404')).toBeVisible();
  await page.getByRole('button', { name: 'Go back' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Good morning, Tanjim' })).toBeVisible();
});

test('an empty list says so', async ({ app: page }) => {
  await openFromSidebar(page, 'Archive', /^Archive/);
  const main = page.getByRole('main');
  await expect(main.getByText('No archived tasks')).toBeVisible();
  await main.getByRole('tab', { name: /^Projects/ }).click();
  await expect(main.getByText('No archived projects')).toBeVisible();
});

test.describe('on a phone-sized screen', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the sidebar becomes a menu that opens and closes', async ({ app: page }) => {
    const openNav = page.getByRole('button', { name: 'Open navigation' });
    await expect(openNav).toBeVisible();
    await expect(sidebar(page).getByRole('button', { name: 'Projects', exact: true })).not.toBeInViewport();

    await openNav.click();
    await expect(sidebar(page).getByRole('button', { name: 'Projects', exact: true })).toBeInViewport();
    await sidebar(page).getByRole('button', { name: 'Projects', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
    await expect(sidebar(page).getByRole('button', { name: 'Projects', exact: true })).not.toBeInViewport();
  });
});
