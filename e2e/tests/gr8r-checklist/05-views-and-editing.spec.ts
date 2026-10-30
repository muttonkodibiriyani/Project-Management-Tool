// Spec section 2: saved views with filter, sort and group; bulk edit; inline cell edit.
import { expect, openProject, projectView, savedView, test } from '../fixtures.js';

const PROJECT = 'Website Redesign';

test('a saved view is a project tab that keeps its own filter, sort and group', async ({ app: page }) => {
  await openProject(page, PROJECT, 'List');
  const main = page.getByRole('main');
  const urgentTask = main.getByRole('button', { name: /WEB-127 Design mobile onboarding/ });
  const lowTask = main.getByRole('button', { name: 'WEB-130 Write homepage copy' });

  await main.getByRole('button', { name: 'Filter', exact: true }).click();
  const filter = page.getByRole('menu');
  await filter.getByRole('button', { name: 'Priority', exact: true }).click();
  await filter.getByRole('checkbox', { name: 'Urgent' }).check();
  await filter.getByRole('checkbox', { name: 'High' }).check();
  await page.keyboard.press('Escape');
  await expect(main.getByRole('button', { name: 'Priority is Urgent, High' })).toBeVisible();
  await expect(lowTask).toBeHidden();

  await page.getByRole('navigation', { name: 'Project views' }).getByRole('button', { name: 'Save view' }).click();
  const dialog = page.getByRole('dialog', { name: 'Save view' });
  await dialog.getByRole('textbox', { name: 'View name' }).fill('Synthetic hot list');
  await dialog.getByRole('button', { name: 'Save view' }).click();
  await expect(dialog).toBeHidden();

  // The new tab starts from the filter it was saved with, and sort and group are set on the tab itself.
  await savedView(page, 'Synthetic hot list');
  await expect(urgentTask).toBeVisible();
  await expect(lowTask).toBeHidden();
  await main.getByRole('button', { name: 'Sort: Manual' }).click();
  await page.getByRole('menu').getByRole('button', { name: 'Title', exact: true }).click();
  await main.getByRole('button', { name: 'Group: Status' }).click();
  await page.getByRole('menu').getByRole('button', { name: 'Priority', exact: true }).click();

  // Clearing the plain list's filter leaves the saved tab's filter, sort and group as they were.
  await projectView(page, 'List');
  await main.getByRole('button', { name: 'Clear all' }).click();
  await expect(lowTask).toBeVisible();
  await savedView(page, 'Synthetic hot list');
  await expect(main.getByRole('button', { name: 'Priority is Urgent, High' })).toBeVisible();
  await expect(main.getByRole('button', { name: 'Sort: Title' })).toBeVisible();
  await expect(main.getByRole('button', { name: 'Group: Priority' })).toBeVisible();
  await expect(urgentTask).toBeVisible();
  await expect(lowTask).toBeHidden();
});

test('bulk edit sets the priority of every selected task', async ({ app: page }) => {
  await openProject(page, PROJECT, 'List');
  const main = page.getByRole('main');
  await main.getByRole('checkbox', { name: 'Select Set up analytics events' }).check();
  await main.getByRole('checkbox', { name: 'Select Migrate blog to new CMS' }).check();
  const bulk = page.getByRole('toolbar', { name: 'Bulk actions' });
  await expect(bulk).toContainText('2 selected');

  await bulk.getByRole('button', { name: 'Priority', exact: true }).click();
  await page.getByRole('menu').getByRole('button', { name: 'Urgent', exact: true }).click();

  // The seeded "High priority" view shows urgent and high tasks only, so both now appear in it.
  await savedView(page, 'High priority');
  await expect(main.getByRole('button', { name: /Set up analytics events/ })).toBeVisible();
  await expect(main.getByRole('button', { name: /Migrate blog to new CMS/ })).toBeVisible();
  await expect(main.getByRole('button', { name: 'WEB-130 Write homepage copy' })).toBeHidden();
});

test('a table cell edits the task in place', async ({ app: page }) => {
  await openProject(page, PROJECT, 'Table');
  const table = page.getByRole('table', { name: 'Tasks table' });
  const row = table.getByRole('row', { name: /^Write homepage copy WEB-130/ });
  await expect(row).toHaveAccessibleName(/^Write homepage copy WEB-130 Backlog Low/);

  await row.getByRole('button', { name: 'Backlog', exact: true }).click();
  await page
    .getByRole('menu')
    .getByRole('menuitemradio', { name: /^Review/ })
    .click();
  await expect(row).toHaveAccessibleName(/^Write homepage copy WEB-130 Review Low/);
  await expect(table.getByRole('row', { name: /^Review \d+$/ })).toHaveAccessibleName('Review 3');
});
