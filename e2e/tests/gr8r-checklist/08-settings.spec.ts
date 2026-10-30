// Spec section 2: settings: theme, accent, density, sidebar, date format, week start, language,
// time zone, motion, home page, open tasks in drawer or page. Each one is changed, seen to take
// effect, and seen to survive a reload.
//
// gr8r-studio names its settings selects by their storage keys (lang, tz, dateFmt, ...), so the
// tests use those names; that they are not human-readable is an accessibility finding for the
// "Check anyone can use it" task, not something to paper over here.
import type { Page } from '@playwright/test';
import { choose, expect, openFromSidebar, openProject, sidebar, test } from '../fixtures.js';

async function openSettings(page: Page, section: string): Promise<void> {
  await openFromSidebar(page, 'Settings', 'Appearance');
  await page.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name: section, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: section })).toBeVisible();
}

async function reload(page: Page): Promise<void> {
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

test('theme, accent, density and motion apply at once and persist', async ({ app: page }) => {
  await openSettings(page, 'Appearance');
  const main = page.getByRole('main');
  const html = page.locator('html');

  await main.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Dark' }).check();
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await main.getByRole('radiogroup', { name: 'Accent color' }).getByRole('radio', { name: 'teal' }).check();
  // The first Compact is the sidebar's density, the second the task display's.
  await main.getByRole('button', { name: 'Compact', exact: true }).first().click();
  await expect(html).toHaveAttribute('data-side', 'compact');
  await main.getByRole('button', { name: 'Compact', exact: true }).last().click();
  await expect(html).toHaveAttribute('data-density', 'compact');
  await choose(main.getByRole('button', { name: 'motion', exact: true }), 'Reduce motion');

  await reload(page);
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await expect(html).toHaveAttribute('data-side', 'compact');
  await expect(html).toHaveAttribute('data-density', 'compact');
  await openSettings(page, 'Appearance');
  await expect(main.getByRole('radio', { name: 'Dark' })).toBeChecked();
  await expect(main.getByRole('radio', { name: 'teal' })).toBeChecked();
  await expect(main.getByRole('button', { name: 'motion', exact: true })).toHaveText('Reduce motion');
});

test('the sidebar collapses and stays collapsed after a reload', async ({ app: page }) => {
  await sidebar(page).getByRole('button', { name: 'Collapse sidebar' }).click();
  await expect(sidebar(page).getByRole('button', { name: 'Collapse sidebar' })).toBeHidden();
  await reload(page);
  await expect(sidebar(page).getByRole('button', { name: 'Collapse sidebar' })).toBeHidden();
});

test('date format and week start change how dates are shown', async ({ app: page }) => {
  await openSettings(page, 'Date & time');
  const main = page.getByRole('main');
  await choose(main.getByRole('button', { name: 'dateFmt', exact: true }), '2026-10-01');
  await choose(main.getByRole('button', { name: 'weekStart', exact: true }), 'Sunday');

  await openProject(page, 'Website Redesign', 'Table');
  const row = page.getByRole('table', { name: 'Tasks table' }).getByRole('row', { name: /^Set up analytics events WEB-133/ });
  await expect(row.getByRole('button', { name: '2026-11-24' })).toBeVisible();

  await openProject(page, 'Website Redesign', 'Calendar');
  await main.getByRole('button', { name: 'Week', exact: true }).click();
  await expect(main.getByRole('heading', { level: 2, name: /^2026-11-01 – 2026-11-07/ })).toBeVisible();
});

test('language and time zone are saved', async ({ app: page }) => {
  await openSettings(page, 'Language');
  await choose(page.getByRole('main').getByRole('button', { name: 'lang', exact: true }), 'English (UK)');
  await openSettings(page, 'Date & time');
  await choose(page.getByRole('main').getByRole('button', { name: 'tz', exact: true }), '(GMT+08:00) Singapore');

  await reload(page);
  await openSettings(page, 'Language');
  await expect(page.getByRole('main').getByRole('button', { name: 'lang', exact: true })).toHaveText('English (UK)');
  await openSettings(page, 'Date & time');
  await expect(page.getByRole('main').getByRole('button', { name: 'tz', exact: true })).toHaveText('(GMT+08:00) Singapore');
});

test('the home page setting picks the page the app opens on', async ({ app: page }) => {
  await openSettings(page, 'Preferences');
  await choose(page.getByRole('main').getByRole('button', { name: 'home', exact: true }), 'My Tasks');
  await reload(page);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('My Tasks');
});

test('tasks open in the side panel or as a full page', async ({ app: page }) => {
  const task = page.getByRole('dialog', { name: 'Task: Create homepage wireframes' });
  const openTask = async () => {
    await openFromSidebar(page, 'Tasks');
    await page
      .getByRole('main')
      .getByRole('button', { name: /^(Show subtasks )?WEB-109 Create homepage wireframes( \d|$)/ })
      .click();
    await expect(task).toBeVisible();
  };

  // The side panel sits beside the page; the full page covers it and takes the focus.
  await openTask();
  await expect(task).toHaveAttribute('aria-modal', 'false');
  const panelWidth = (await task.boundingBox())?.width ?? 0;
  await task.getByRole('button', { name: 'Close' }).click();
  await expect(task).toBeHidden();

  await openSettings(page, 'Preferences');
  await choose(page.getByRole('main').getByRole('button', { name: 'openTasks', exact: true }), 'Full page');
  await openTask();
  await expect(task).toHaveAttribute('aria-modal', 'true');
  expect((await task.boundingBox())?.width ?? 0).toBeGreaterThan(panelWidth);
});
