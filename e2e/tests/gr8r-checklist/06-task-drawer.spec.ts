// Spec section 2: task drawer: subtasks, dependencies, attachments, comments with @mentions and
// reactions, activity, recurring tasks.
import type { Locator, Page } from '@playwright/test';
import { expect, openFromSidebar, test } from '../fixtures.js';

/** A task row on the Tasks page, named by its key and title (and a subtask toggle when it has subtasks). */
function taskRow(page: Page, title: string): Locator {
  return page.getByRole('main').getByRole('button', { name: new RegExp(`^(Show subtasks )?[A-Z]+-\\d+ ${title}( \\d|$)`) });
}

async function openTask(page: Page, title: string): Promise<Locator> {
  await openFromSidebar(page, 'Tasks');
  await taskRow(page, title).click();
  const drawer = page.getByRole('dialog', { name: `Task: ${title}` });
  await expect(drawer).toBeVisible();
  return drawer;
}

test('subtasks are added and completed with the progress shown', async ({ app: page }) => {
  const drawer = await openTask(page, 'Create homepage wireframes');
  await expect(drawer.getByText('3/4', { exact: true })).toBeVisible();

  await drawer.getByRole('textbox', { name: 'Add subtask' }).fill('Synthetic fixture check');
  await drawer.getByRole('textbox', { name: 'Add subtask' }).press('Enter');
  await expect(drawer.getByText('3/5', { exact: true })).toBeVisible();

  await drawer.getByRole('checkbox', { name: 'Complete subtask Synthetic fixture check' }).click();
  await expect(drawer.getByRole('checkbox', { name: 'Reopen subtask Synthetic fixture check' })).toBeChecked();
  await expect(drawer.getByText('4/5', { exact: true })).toBeVisible();
});

test('a task records what blocks it', async ({ app: page }) => {
  const drawer = await openTask(page, 'Create homepage wireframes');
  await drawer.getByRole('button', { name: 'None', exact: true }).click();
  await page.getByRole('menu').getByRole('menuitemradio', { name: 'WEB-103 Audit existing navigation' }).click();
  await expect(drawer.getByRole('definition').filter({ hasText: 'Audit existing navigation' })).toBeVisible();
});

test('attachments upload and remove', async ({ app: page }) => {
  const drawer = await openTask(page, 'Create homepage wireframes');
  await drawer.getByLabel('Upload').setInputFiles({
    name: 'synthetic-floor-plan.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4 synthetic test file\n'),
  });
  const file = drawer.getByRole('button', { name: /synthetic-floor-plan\.pdf/ });
  await expect(file).toBeVisible();

  await file.getByRole('button', { name: 'Remove attachment' }).click();
  await expect(file).toBeHidden();
  await expect(drawer.getByRole('button', { name: /homepage-wireframes-v3\.fig/ })).toBeVisible();
});

test('comments mention a member and take reactions', async ({ app: page }) => {
  const drawer = await openTask(page, 'Create homepage wireframes');
  const comment = drawer.getByRole('textbox', { name: 'Comment' });
  await comment.click();
  await page.keyboard.type('Synthetic check for @Pri');
  // The suggestion list offers each matching member with their title.
  await drawer.getByRole('button', { name: 'Priya Patel Priya Patel Content Strategist' }).click();
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(drawer.getByText(/^Synthetic check for @Priya Patel/)).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Comments 4' })).toBeVisible();

  await drawer.getByRole('button', { name: 'Add reaction' }).first().click();
  await page.getByRole('menu').getByRole('button', { name: 'React 🚀' }).click();
  await expect(drawer.getByRole('button', { name: '🚀 1' })).toBeVisible();
});

test('activity records a change to the task', async ({ app: page }) => {
  const drawer = await openTask(page, 'Create homepage wireframes');
  await drawer.getByRole('button', { name: 'Priority' }).click();
  await page.getByRole('menu').getByRole('menuitemradio', { name: 'Urgent' }).click();
  await expect(drawer.getByRole('button', { name: 'Priority' })).toHaveText(/Urgent/);

  await drawer.getByRole('button', { name: /^Activity \d+$/ }).click();
  await expect(drawer.getByText(/changed priority/i)).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Activity 2' })).toBeVisible();
});

test('completing a recurring task creates the next one', async ({ app: page }) => {
  const drawer = await openTask(page, 'Prepare design system tokens');
  await drawer.getByRole('button', { name: 'Does not repeat' }).click();
  await page.getByRole('menu').getByRole('menuitemradio', { name: 'Weekly' }).click();
  await expect(drawer.getByRole('button', { name: 'Weekly' })).toBeVisible();

  await drawer.getByRole('button', { name: 'Mark complete' }).click();
  await drawer.getByRole('button', { name: 'Close' }).click();
  await expect(drawer).toBeHidden();
  await expect(taskRow(page, 'Prepare design system tokens')).toHaveCount(2);
});
