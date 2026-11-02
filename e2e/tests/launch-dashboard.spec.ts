import { expect, openFromSidebar, openProject, projectView, test } from './fixtures.js';

const LAUNCH = 'Synthetic two-store launch';

test('launch overview, fixtures and directories are computed from canonical launch data', async ({ app: page }) => {
  await openProject(page, LAUNCH);
  await expect(page).toHaveTitle(/^Table · Synthetic two-store launch/);

  await projectView(page, 'Overview');
  const main = page.getByRole('main');
  await expect(main.getByText('258 listed', { exact: true })).toBeVisible();
  await expect(main.getByText('213 listed', { exact: true })).toBeVisible();
  await expect(main.getByRole('heading', { name: 'Readiness by gate' })).toBeVisible();
  await expect(main.getByRole('heading', { name: 'Brand-code mix' })).toBeVisible();

  await openFromSidebar(page, 'Stores & fixtures');
  await page.getByRole('navigation', { name: 'Stores and fixture views' }).getByRole('button', { name: 'Capacity' }).click();
  await expect(page.getByText(/fixture types are over allocated/i)).toBeVisible();
  await expect(page.getByText(/over by \d+/i).first()).toBeVisible();

  await openFromSidebar(page, 'Brands & vendors');
  await expect(page.getByRole('cell', { name: 'Sample Distribution A', exact: true }).first()).toBeVisible();
  await expect(page.getByRole('cell', { name: /35%/ }).first()).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Brand directory views' })
    .getByRole('button', { name: /Contacts/ })
    .click();
  await expect(page.getByRole('link', { name: 'contact1@example.test' })).toBeVisible();
});

test('one click raises a linked follow-up in the owner flow', async ({ app: page }) => {
  await openProject(page, LAUNCH, 'Overview');
  const follow = page.getByRole('button', { name: 'Follow up', exact: true }).first();
  await follow.click();
  await expect(page.getByText(/Follow-up sent to .* due/)).toBeVisible();

  await projectView(page, 'Follow-ups');
  await expect(page.getByText('3 open', { exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: /Follow up: / }).last()).toBeVisible();
  await expect(page.getByRole('cell', { name: /TST-\d+/ }).last()).toBeVisible();
});

test('ordinary gr8r projects still open on their board', async ({ app: page }) => {
  await openProject(page, 'Website Redesign');
  await expect(page).toHaveTitle(/^Board · Website Redesign/);
  await expect(page.getByRole('region', { name: 'Backlog', exact: true })).toBeVisible();
});
