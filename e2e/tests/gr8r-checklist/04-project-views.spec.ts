// Spec section 2: project views: overview, board, list, table, calendar, timeline, files.
import { expect, openProject, test } from '../fixtures.js';

const PROJECT = 'Website Redesign';
const STATUSES = ['Backlog', 'To Do', 'In Progress', 'Review', 'Done'];

test('overview summarises progress and what is coming up', async ({ app: page }) => {
  await openProject(page, PROJECT, 'Overview');
  const main = page.getByRole('main');
  await expect(main.getByText(/4 of 18 tasks done/)).toBeVisible();
  for (const status of STATUSES) await expect(main.getByRole('button', { name: new RegExp(`^${status} \\d+$`) })).toBeVisible();
  await expect(main.getByRole('heading', { name: 'Coming up' })).toBeVisible();
  await expect(main.getByRole('checkbox', { name: 'Complete Finalize navigation' })).toBeVisible();
});

test('board has a column per status and adds a card', async ({ app: page }) => {
  await openProject(page, PROJECT, 'Board');
  for (const status of STATUSES) await expect(page.getByRole('region', { name: status, exact: true })).toBeVisible();

  const backlog = page.getByRole('region', { name: 'Backlog', exact: true });
  await backlog.getByRole('button', { name: 'Add task to Backlog' }).click();
  await page.keyboard.type('Synthetic signage check');
  await page.keyboard.press('Enter');
  await expect(backlog.getByRole('button', { name: 'Synthetic signage check', exact: true })).toBeVisible();
});

test('list groups tasks by status and collapses a group', async ({ app: page }) => {
  await openProject(page, PROJECT, 'List');
  const main = page.getByRole('main');
  const audit = main.getByRole('button', { name: 'WEB-103 Audit existing navigation' });
  await expect(audit).toBeVisible();

  const doneGroup = main.getByRole('button', { name: 'Add task to Done' }).locator('..');
  await doneGroup.getByRole('button', { name: 'Toggle group' }).click();
  await expect(audit).toBeHidden();
  await doneGroup.getByRole('button', { name: 'Toggle group' }).click();
  await expect(audit).toBeVisible();
});

test('table shows task fields as columns and sorts by one', async ({ app: page }) => {
  await openProject(page, PROJECT, 'Table');
  const table = page.getByRole('table', { name: 'Tasks table' });
  for (const column of ['Task', 'Status', 'Priority', 'Assignee', 'Due date', 'Labels', 'Estimate']) {
    await expect(table.getByRole('columnheader', { name: column, exact: true })).toBeVisible();
  }
  // The first task under the Backlog group heading, which is row 1 of the body.
  const firstBacklogTask = table.getByRole('rowgroup').nth(1).getByRole('row').nth(1);
  await expect(firstBacklogTask).toHaveAccessibleName(/^Write homepage copy WEB-130 Backlog Low/);

  await page.getByRole('main').getByRole('button', { name: 'Sort: Manual' }).click();
  await page.getByRole('menu').getByRole('button', { name: 'Title', exact: true }).click();
  await expect(page.getByRole('main').getByRole('button', { name: 'Sort: Title' })).toBeVisible();
  await expect(firstBacklogTask).toHaveAccessibleName(/^Accessibility audit of templates WEB-136/);
});

test('calendar shows the month and moves between months and weeks', async ({ app: page }) => {
  await openProject(page, PROJECT, 'Calendar');
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { level: 2, name: 'November 2026' })).toBeVisible();
  await expect(main.getByRole('button', { name: 'Add task on Nov 4' })).toBeVisible();

  await main.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(main.getByRole('heading', { level: 2, name: 'December 2026' })).toBeVisible();
  await main.getByRole('button', { name: 'Today', exact: true }).click();
  await expect(main.getByRole('heading', { level: 2, name: 'November 2026' })).toBeVisible();

  await main.getByRole('button', { name: 'Week', exact: true }).click();
  await expect(main.getByRole('heading', { level: 2, name: 'Nov 2 – Nov 8, 2026' })).toBeVisible();
  await expect(main.getByRole('button', { name: /^Create homepage wireframes Website Redesign/ })).toBeVisible();
});

test('timeline draws a bar per task with the milestones lane', async ({ app: page }) => {
  await openProject(page, PROJECT, 'Timeline');
  const main = page.getByRole('main');
  await expect(main.getByText(/Milestones\s*3/)).toBeVisible();
  // A bar's text depends on how wide it is drawn, so find it by its tooltip.
  const bar = main.getByTitle(/^Create homepage wireframes · Oct 29/);
  await expect(bar).toBeVisible();
  const weekWidth = (await bar.boundingBox())?.width ?? 0;

  // The same bar is narrower when each column is a month rather than a week.
  await main.getByRole('button', { name: 'Months', exact: true }).click();
  await expect.poll(async () => (await bar.boundingBox())?.width ?? 0).toBeLessThan(weekWidth);
});

test('files lists the project’s files and searches them', async ({ app: page }) => {
  await openProject(page, PROJECT, 'Files');
  const main = page.getByRole('main');
  await expect(main.getByRole('button', { name: /^pdf sitemap-v2\.pdf/ })).toBeVisible();
  await expect(main.getByRole('button', { name: /^fig homepage-wireframes-v3\.fig/ })).toBeVisible();

  await main.getByRole('textbox', { name: 'Search files' }).fill('sitemap');
  await expect(main.getByRole('button', { name: /^pdf sitemap-v2\.pdf/ })).toBeVisible();
  await expect(main.getByRole('button', { name: /^fig homepage-wireframes-v3\.fig/ })).toBeHidden();
});
