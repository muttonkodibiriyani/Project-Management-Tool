// Spec section 2: home dashboard, inbox, notifications, my tasks, all tasks, favourites.
import { expect, openFromSidebar, openProject, sidebar, test } from '../fixtures.js';

test('home dashboard greets the user and summarises the workspace', async ({ app: page }) => {
  await expect(page).toHaveTitle('Home · Gr8r Studio');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Good morning, Tanjim');
  for (const card of [/^Active projects \d+/, /^Open tasks \d+/, /^Completed \d+/, /^Overdue \d+/]) {
    await expect(page.getByRole('button', { name: card })).toBeVisible();
  }
  await expect(page.getByRole('table').getByRole('link', { name: /^Website Redesign/ })).toBeVisible();

  const myTasks = page.getByRole('region', { name: 'My tasks' });
  await expect(myTasks.getByRole('checkbox', { name: 'Complete Budget approval' })).toBeHidden();
  await myTasks.getByRole('tab', { name: /^Overdue/ }).click();
  await expect(myTasks.getByRole('checkbox', { name: 'Complete Budget approval' })).toBeVisible();
});

test('inbox marks every notification read', async ({ app: page }) => {
  await openFromSidebar(page, 'Inbox 4', 'Inbox');
  const main = page.getByRole('main');
  await expect(main.getByRole('button', { name: 'Mark as read' }).first()).toBeVisible();

  await main.getByRole('button', { name: 'Mark all as read' }).click();
  await expect(main.getByRole('button', { name: 'Mark as read' })).toHaveCount(0);
  await expect(sidebar(page).getByRole('button', { name: 'Inbox', exact: true })).toBeVisible();
});

test('notifications filter to unread and toggle one read', async ({ app: page }) => {
  await openFromSidebar(page, 'Notifications 6', /^Notifications/);
  const main = page.getByRole('main');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Notifications 6 unread');

  const unread = main.getByRole('button', { name: /Unread Toggle read$/ });
  await expect(main.getByRole('button', { name: /[^d] Toggle read$/ })).not.toHaveCount(0);
  await main.getByRole('button', { name: 'Unread', exact: true }).click();
  await expect(main.getByRole('button', { name: /[^d] Toggle read$/ })).toHaveCount(0);
  await expect(unread).toHaveCount(6);

  await unread.first().getByRole('button', { name: 'Toggle read' }).click();
  await expect(unread).toHaveCount(5);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Notifications 5 unread');
});

test('my tasks lists the user’s tasks and completes one', async ({ app: page }) => {
  await openFromSidebar(page, 'My Tasks 2', 'My Tasks');
  const tasks = page.getByRole('table', { name: 'Tasks' });
  // The group header holds its toggle, its name and its count.
  const completed = tasks.getByRole('button', { name: 'Add task to Completed' }).locator('..');
  await expect(completed).toHaveText(/Completed\s*1/);

  await tasks.getByRole('checkbox', { name: 'Mark Prepare design system tokens complete' }).click();
  await expect(page.getByText('Completed “Prepare design system tokens”')).toBeVisible();
  await expect(completed).toHaveText(/Completed\s*2/);
  await expect(tasks.getByRole('checkbox', { name: 'Mark Prepare design system tokens complete' })).toBeHidden();
});

test('all tasks searches across every project', async ({ app: page }) => {
  await openFromSidebar(page, 'Tasks');
  const main = page.getByRole('main');
  await expect(main.getByRole('button', { name: /Create homepage wireframes/ })).toBeVisible();
  await expect(main.getByRole('button', { name: /Triage beta tester feedback/ })).toBeVisible();

  await main.getByRole('textbox', { name: 'Search tasks' }).fill('wireframes');
  await expect(main.getByRole('button', { name: /Create homepage wireframes/ })).toBeVisible();
  await expect(main.getByRole('button', { name: /Triage beta tester feedback/ })).toHaveCount(0);
});

test('favourites list starred tasks and projects', async ({ app: page }) => {
  await openFromSidebar(page, 'Favorites');
  await expect(page.getByRole('main').getByText('Marketing Campaign', { exact: true })).toBeHidden();

  await openProject(page, 'Marketing Campaign');
  const star = page.getByRole('main').getByRole('button', { name: 'Favorite', exact: true });
  await expect(star).toHaveAttribute('aria-pressed', 'false');
  await star.click();
  await expect(star).toHaveAttribute('aria-pressed', 'true');

  await openFromSidebar(page, 'Favorites');
  await expect(page.getByRole('main').getByText('Marketing Campaign', { exact: true })).toBeVisible();
});
