// Spec section 2: members, roles (Owner, Admin, Member, Guest), invites, teams, activity feed.
import { choose, expect, openFromSidebar, sidebar, test } from '../fixtures.js';

const ROLES = ['Owner', 'Admin', 'Member', 'Guest'];

test('members filter by role and a member’s role changes', async ({ app: page }) => {
  await openFromSidebar(page, 'Members');
  const main = page.getByRole('main');
  const members = main.getByRole('table').getByRole('rowgroup').nth(1).getByRole('row');
  await expect(members.filter({ hasText: 'Tanjim Islam (you)' })).toContainText('Owner');

  for (const role of ROLES) await expect(main.getByRole('button', { name: role, exact: true }).first()).toBeVisible();
  await main.getByRole('button', { name: 'Admin', exact: true }).first().click();
  // The seeded workspace has two admins.
  await expect(members).toHaveCount(2);
  await expect(members.filter({ hasText: 'sarah@gr8rstudio.com' })).toBeVisible();
  await expect(members.filter({ hasText: 'lena@gr8rstudio.com' })).toBeVisible();
  await main.getByRole('button', { name: 'All', exact: true }).click();

  const john = members.filter({ hasText: 'john@gr8rstudio.com' });
  await john.getByRole('button', { name: 'Member', exact: true }).click();
  await page
    .getByRole('menu')
    .getByRole('button', { name: /^Admin / })
    .click();
  await expect(john.getByRole('button', { name: 'Admin', exact: true })).toBeVisible();
  await main.getByRole('button', { name: 'Admin', exact: true }).first().click();
  await expect(members).toHaveCount(3);
});

test('roles and permissions explain each role', async ({ app: page }) => {
  await openFromSidebar(page, 'Members');
  const main = page.getByRole('main');
  await main.getByRole('button', { name: 'Roles & permissions' }).click();
  for (const role of ROLES) await expect(main.getByRole('columnheader', { name: role, exact: true })).toBeVisible();
});

test('an invite adds a pending member with the chosen role', async ({ app: page }) => {
  await openFromSidebar(page, 'Members');
  const main = page.getByRole('main');
  await expect(main.getByText(/· 1 pending$/)).toBeVisible();

  await main.getByRole('button', { name: 'Invite member' }).click();
  const dialog = page.getByRole('dialog', { name: 'Invite to Gr8r Studio' });
  await dialog.getByRole('textbox', { name: 'Email addresses' }).fill('synthetic.buyer@example.test');
  await choose(dialog.getByRole('button', { name: 'Role' }), 'Guest');
  await dialog.getByRole('button', { name: 'Send invites' }).click();
  await expect(dialog).toBeHidden();

  await expect(main.getByText(/· 2 pending$/)).toBeVisible();
  const invited = main.getByRole('row', { name: /synthetic\.buyer@example\.test/ });
  await expect(invited).toContainText('Guest');
});

test('a new team appears under Teams in the sidebar', async ({ app: page }) => {
  await sidebar(page).getByRole('button', { name: 'New team' }).click();
  const dialog = page.getByRole('dialog', { name: 'New team' });
  await dialog.getByRole('textbox', { name: 'Team name' }).fill('Synthetic Openings');
  await dialog.getByRole('textbox', { name: 'What does this team own?' }).fill('Store opening checklists');
  await dialog.getByRole('radio', { name: 'rocket' }).check();
  await dialog.getByRole('button', { name: /^Create/ }).click();
  await expect(dialog).toBeHidden();

  await expect(sidebar(page).getByRole('button', { name: 'Synthetic Openings' })).toBeVisible();
  await openFromSidebar(page, 'Members');
  await page.getByRole('main').getByRole('button', { name: 'Teams', exact: true }).click();
  await expect(page.getByRole('main').getByRole('link', { name: /^Synthetic Openings Store opening checklists/ })).toBeVisible();
});

test('the activity feed shows a change as it happens', async ({ app: page }) => {
  await openFromSidebar(page, 'My Tasks 2', 'My Tasks');
  await page.getByRole('table', { name: 'Tasks' }).getByRole('checkbox', { name: 'Mark Prepare design system tokens complete' }).click();
  await expect(page.getByText('Completed “Prepare design system tokens”')).toBeVisible();

  await openFromSidebar(page, 'Activity');
  await expect(
    page
      .getByRole('main')
      .getByText(/completed.*Prepare design system tokens/)
      .first(),
  ).toBeVisible();
});
