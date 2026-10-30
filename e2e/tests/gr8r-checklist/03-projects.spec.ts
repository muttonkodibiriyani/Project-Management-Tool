// Spec section 2: projects in grid and list, templates, milestones, private projects, archive.
import { choose, expect, openFromSidebar, openProject, projectView, sidebar, test } from '../fixtures.js';

test('projects show as a grid and as a list', async ({ app: page }) => {
  await openFromSidebar(page, 'Projects');
  const main = page.getByRole('main');
  const layout = main.getByRole('tablist', { name: 'Layout' });
  await expect(main.getByRole('link', { name: 'Website Redesign', exact: true })).toBeVisible();

  await layout.getByRole('button', { name: 'List', exact: true }).click();
  await expect(main.getByRole('link', { name: 'Website Redesign', exact: true })).toBeHidden();
  await expect(main.getByText('Website Redesign', { exact: true })).toBeVisible();

  await layout.getByRole('button', { name: 'Grid', exact: true }).click();
  await expect(main.getByRole('link', { name: 'Website Redesign', exact: true })).toBeVisible();
});

test('a project created from a template starts with its tasks', async ({ app: page }) => {
  await page.keyboard.press('p');
  const dialog = page.getByRole('dialog', { name: 'New project' });
  await dialog.getByRole('textbox', { name: 'Project name' }).fill('Synthetic Store Opening');
  await dialog.getByRole('radio', { name: /^Website 6 starter tasks/ }).check();
  await dialog.getByRole('button', { name: 'Create project' }).click();
  await expect(dialog).toBeHidden();

  await expect(page.getByRole('heading', { level: 1, name: 'Synthetic Store Opening' })).toBeVisible();
  await projectView(page, 'List');
  await expect(page.getByRole('main').getByRole('button', { name: 'More actions' })).toHaveCount(6);
  await expect(sidebar(page).getByRole('link', { name: /Synthetic Store Opening/ })).toBeVisible();
});

test('milestones show on the project overview and the timeline', async ({ app: page }) => {
  await openProject(page, 'Website Redesign', 'Overview');
  const main = page.getByRole('main');
  for (const milestone of ['Wireframes signed off', 'Dev handoff', 'Public launch']) {
    await expect(main.getByText(milestone, { exact: true })).toBeVisible();
  }

  await projectView(page, 'Timeline');
  await expect(main.getByLabel(/^Milestone: .*Wireframes signed off/)).toBeAttached();
});

test('a private project is closed to people not invited', async ({ app: page }) => {
  await openProject(page, 'Website Redesign');
  await page.getByRole('main').getByRole('button', { name: 'Share', exact: true }).click();
  const share = page.getByRole('dialog');
  await choose(share.getByRole('button', { name: 'General access' }), 'Only people invited');
  await expect(share.getByText('Only people listed above can open this project.')).toBeVisible();
  await share.getByRole('button', { name: 'Done' }).click();
  await expect(share).toBeHidden();
  await page.getByRole('main').getByRole('button', { name: 'Share', exact: true }).click();
  await expect(share.getByRole('button', { name: 'General access' })).toHaveText('Only people invited');
  await share.getByRole('button', { name: 'Done' }).click();

  // The seeded Customer Portal is private and the signed-in user is not on it.
  await openFromSidebar(page, 'Projects');
  await page.getByRole('main').getByRole('link', { name: 'Customer Portal', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: "You don't have access" })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Request access' })).toBeVisible();
});

test('an archived project leaves the lists and can be restored', async ({ app: page }) => {
  await openFromSidebar(page, 'Projects');
  const main = page.getByRole('main');
  const card = main.getByRole('link', { name: 'Marketing Campaign', exact: true });
  await card.getByRole('button', { name: 'Project options' }).click();
  await page.getByRole('menu').getByRole('button', { name: 'Archive project' }).click();
  const confirm = page.getByRole('dialog', { name: 'Archive Marketing Campaign?' });
  await confirm.getByRole('button', { name: 'Archive project' }).click();
  await expect(confirm).toBeHidden();
  await expect(card).toBeHidden();
  await expect(sidebar(page).getByRole('link', { name: /Marketing Campaign/ })).toBeHidden();

  await openFromSidebar(page, 'Archive 1', /^Archive/);
  await main.getByRole('tab', { name: /^Projects/ }).click();
  await main
    .getByRole('button', { name: /Restore/ })
    .first()
    .click();
  await expect(page.getByText('Restored Marketing Campaign')).toBeVisible();
  await expect(sidebar(page).getByRole('link', { name: /Marketing Campaign/ })).toBeVisible();
});
