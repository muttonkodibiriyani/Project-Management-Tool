import { expect, openFromSidebar, openProject, projectView, test } from './fixtures.js';

const LAUNCH = 'Synthetic two-store launch';

test('launch overview, fixtures and public directories are computed without exposing restricted data', async ({ app: page }) => {
  await openProject(page, LAUNCH);
  await expect(page).toHaveTitle(/^Table · Synthetic two-store launch/);

  await projectView(page, 'Overview');
  const main = page.getByRole('main');
  await expect(main.getByText('258 listed', { exact: true })).toBeVisible();
  await expect(main.getByText('213 listed', { exact: true })).toBeVisible();
  await expect(main.getByRole('heading', { name: 'Readiness by gate' })).toBeVisible();
  await expect(main.getByRole('heading', { name: 'Brand-code mix' })).toBeVisible();
  await expect(main.getByRole('heading', { name: 'Details' })).toBeVisible();
  await expect(main.getByRole('heading', { name: 'Milestones' })).toBeVisible();
  await expect(main.getByRole('heading', { name: 'Recent activity' })).toBeVisible();

  await openFromSidebar(page, 'Stores & fixtures');
  await page.getByRole('navigation', { name: 'Stores and fixture views' }).getByRole('button', { name: 'Capacity' }).click();
  await expect(page.getByText(/fixture types are over allocated/i)).toBeVisible();
  await expect(page.getByText(/over by \d+/i).first()).toBeVisible();

  await openFromSidebar(page, 'Brands & vendors');
  await expect(page.getByRole('cell', { name: 'Sample Distribution A', exact: true }).first()).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Restricted', exact: true }).first()).toBeVisible();
  await expect(page.getByRole('cell', { name: /35%/ })).toHaveCount(0);
  await page
    .getByRole('navigation', { name: 'Brand directory views' })
    .getByRole('button', { name: /Contacts/ })
    .click();
  await expect(page.getByText('Contact details are restricted.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'contact1@example.test' })).toHaveCount(0);
});

test('one click raises a linked follow-up in the owner flow', async ({ app: page }) => {
  await openProject(page, LAUNCH, 'Overview');
  const follow = page.getByRole('button', { name: 'Follow up', exact: true }).first();
  await follow.click();
  // The first risk is vendor comms. Its line belongs to m1, while team-comms is
  // canonically owned by m2/Sarah; this catches a silent fallback to the line assignee.
  await expect(page.getByText(/Follow-up sent to Sarah Chen .* due/)).toBeVisible();

  await projectView(page, 'Follow-ups');
  await expect(page.getByText('3 open', { exact: true })).toBeVisible();
  const newFollowUp = page.getByRole('row').filter({ hasText: 'Follow up: Vendor comms · Sample Brand 01 · Prestige' });
  await expect(newFollowUp).toContainText('TST-001');
  await expect(newFollowUp).toContainText('Sarah Chen');
  await expect(newFollowUp).toContainText('Nov 7');

  await openFromSidebar(page, /^Inbox/, 'Inbox');
  await expect(
    page
      .getByRole('main')
      .getByText(/asked you to follow up/)
      .first(),
  ).toBeVisible();
  await expect(
    page
      .getByRole('main')
      .getByText(/TST-001 .* due 2026-11-07/)
      .first(),
  ).toBeVisible();
});

test('ordinary gr8r projects still open on their board', async ({ app: page }) => {
  await openProject(page, 'Website Redesign');
  await expect(page).toHaveTitle(/^Board · Website Redesign/);
  await expect(page.getByRole('region', { name: 'Backlog', exact: true })).toBeVisible();
});

test('launch overview and capacity stay usable at both supported phone widths', async ({ app: page }) => {
  await openProject(page, LAUNCH, 'Overview');
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 412, height: 915 },
  ]) {
    await page.setViewportSize(viewport);
    const stats = page.locator('.launch-stats .launch-stat');
    const first = await stats.nth(0).boundingBox();
    const second = await stats.nth(1).boundingBox();
    expect(first?.width).toBeGreaterThan(viewport.width - 64);
    expect(second?.y).toBeGreaterThan((first?.y ?? 0) + (first?.height ?? 0) - 1);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await openFromSidebar(page, 'Stores & fixtures');
  await page.getByRole('navigation', { name: 'Stores and fixture views' }).getByRole('button', { name: 'Capacity' }).click();
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 412, height: 915 },
  ]) {
    await page.setViewportSize(viewport);
    const card = page
      .locator('.launch-page-table tbody tr')
      .filter({ hasText: /over by \d+/i })
      .first();
    await expect(card).toBeVisible();
    await expect(card.getByText(/over by \d+/i).first()).toBeVisible();
    await expect.poll(() => card.evaluate(node => getComputedStyle(node).display)).toBe('grid');
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  }
});
