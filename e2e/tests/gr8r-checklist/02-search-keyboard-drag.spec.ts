// Spec section 2: search and command palette, keyboard shortcuts, drag and drop.
import { expect, openProject, sidebar, test } from '../fixtures.js';

test('search finds a task and opens it', async ({ app: page }) => {
  await page.getByRole('button', { name: 'Search and commands' }).click();
  const palette = page.getByRole('dialog', { name: 'Command menu' });
  await palette.getByRole('combobox').fill('wireframes');
  await palette.getByRole('option', { name: /Create homepage wireframes/ }).click();

  await expect(page.getByRole('dialog', { name: 'Task: Create homepage wireframes' })).toBeVisible();
});

test('command palette runs a command from the keyboard', async ({ app: page }) => {
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: 'Command menu' });
  await expect(palette).toBeVisible();

  await palette.getByRole('combobox').fill('Go to Members');
  await expect(palette.getByRole('option', { name: /^Go to Members/ })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
  await expect(page.getByRole('heading', { level: 1, name: 'Members' })).toBeVisible();
});

test('keyboard shortcuts navigate, create and toggle', async ({ app: page }) => {
  await page.keyboard.press('?');
  const shortcuts = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(shortcuts).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(shortcuts).toBeHidden();

  await page.keyboard.press('g');
  await page.keyboard.press('p');
  await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();

  await page.keyboard.press('n');
  await expect(page.getByRole('dialog', { name: /New task/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: /New task/ })).toBeHidden();

  await expect(sidebar(page).getByRole('button', { name: 'Collapse sidebar' })).toBeVisible();
  await page.keyboard.press('[');
  await expect(sidebar(page).getByRole('button', { name: 'Collapse sidebar' })).toBeHidden();
  await page.keyboard.press('[');
  await expect(sidebar(page).getByRole('button', { name: 'Collapse sidebar' })).toBeVisible();

  const html = page.locator('html');
  await expect(html).not.toHaveAttribute('data-theme', 'dark');
  await page.keyboard.press('ControlOrMeta+Shift+L');
  await expect(html).toHaveAttribute('data-theme', 'dark');
});

test('drag and drop moves a card to another board column', async ({ app: page }) => {
  await openProject(page, 'Website Redesign', 'Board');
  const todo = page.getByRole('region', { name: 'To Do' });
  const review = page.getByRole('region', { name: 'Review' });
  const card = todo.getByRole('button', { name: 'Build hero component', exact: true });
  await expect(review.getByRole('button', { name: 'Build hero component', exact: true })).toHaveCount(0);

  await card.dragTo(review);
  await expect(review.getByRole('button', { name: 'Build hero component', exact: true })).toBeVisible();
  await expect(todo.getByRole('button', { name: 'Build hero component', exact: true })).toHaveCount(0);
});
