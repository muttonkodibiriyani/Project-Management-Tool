import { test as base, expect, type Locator, type Page } from '@playwright/test';

/**
 * Every test starts from a fresh browser context, so gr8r-studio seeds its demo workspace into an
 * empty localStorage: each test owns its data and never sees another test's changes.
 *
 * The clock is fixed, because the seed dates tasks relative to today ("Today", "Tomorrow", "2d ago"):
 * a frozen Wednesday morning keeps every relative date the same on every run.
 */
export const FIXED_NOW = new Date('2026-11-04T07:00:00Z'); // Wednesday 4 November, 10:00 in Doha

type Fixtures = {
  /** The app, loaded and showing its first page. */
  app: Page;
  /** Fails the test on any uncaught error, console error, or request that leaves the app's own origin. */
  browserErrors: string[];
};

export const test = base.extend<Fixtures>({
  browserErrors: [
    async ({ page, baseURL }, use) => {
      const errors: string[] = [];
      const origin = new URL(baseURL ?? '').origin;
      // gr8r-studio loads its fonts from Google Fonts. Answer with an empty stylesheet so the suite
      // never depends on the internet; the app falls back to system fonts, as it does offline.
      await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
      await page.route(
        url => url.origin !== origin && url.hostname !== 'fonts.googleapis.com' && url.protocol.startsWith('http'),
        async route => {
          errors.push(`request outside the app: ${route.request().url()}`);
          await route.abort();
        },
      );
      page.on('pageerror', error => errors.push(`uncaught error: ${error.message}`));
      page.on('console', message => {
        if (message.type() === 'error') errors.push(`console error: ${message.text()}`);
      });
      await use(errors);
      expect(errors, 'the browser reported errors').toEqual([]);
    },
    { auto: true },
  ],

  app: async ({ page }, use) => {
    await page.clock.setFixedTime(FIXED_NOW);
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await use(page);
  },
});

export { expect };

/** The main sidebar. */
export const sidebar = (page: Page): Locator => page.getByRole('navigation', { name: 'Main' });

/** Opens a page from the sidebar and waits for its heading. */
export async function openFromSidebar(page: Page, name: string | RegExp, heading: string | RegExp = name): Promise<void> {
  await sidebar(page)
    .getByRole('button', { name, exact: typeof name === 'string' })
    .first()
    .click();
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
}

/** Opens a project from the Projects page. */
export async function openProject(page: Page, project: string, view?: string): Promise<void> {
  await openFromSidebar(page, 'Projects');
  await page.getByRole('main').getByRole('link', { name: project, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: project })).toBeVisible();
  if (view) await projectView(page, view);
}

/** Switches the open project to one of its views (Overview, Board, List, Table, ...). */
export async function projectView(page: Page, view: string): Promise<void> {
  const views = page.getByRole('navigation', { name: 'Project views' });
  await views.getByRole('button', { name: view, exact: true }).click();
  await expect(page).toHaveTitle(new RegExp(`^${view} · `));
}

/** Opens one of the open project's saved views, which sit as tabs after the built-in views. */
export async function savedView(page: Page, view: string): Promise<void> {
  const views = page.getByRole('navigation', { name: 'Project views' });
  await views.getByRole('button', { name: view, exact: true }).click();
  await expect(page).toHaveTitle(/^Saved view · /);
}

/**
 * gr8r-studio draws every <select> as a button that opens a listbox. Picks an option from one.
 */
export async function choose(trigger: Locator, option: string): Promise<void> {
  await trigger.click();
  const listbox = trigger.page().getByRole('listbox');
  await listbox.getByRole('option', { name: option, exact: true }).click();
  await expect(listbox).toBeHidden();
}
