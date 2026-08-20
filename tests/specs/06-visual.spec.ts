import { test, expect } from '@playwright/test';
import { CORE, setScenario } from '../helpers';

test.beforeEach(async ({ page }) => setScenario(page, 'default'));

test('dark background #0A0A0F, no light mode', async ({ page }) => {
  await page.goto('/setup');
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  // #0A0A0F === rgb(10, 10, 15)
  expect(bg).toBe('rgb(10, 10, 15)');
});

test('primary button uses the 135deg blue gradient', async ({ page }) => {
  await page.goto('/setup');
  const btn = page.getByRole('button', { name: /Ja tenho tudo isso/ });
  const bgImage = await btn.evaluate((el) => getComputedStyle(el).backgroundImage);
  expect(bgImage).toContain('linear-gradient');
  expect(bgImage).toContain('30, 58, 138'); // #1E3A8A
  expect(bgImage).toContain('59, 130, 246'); // #3B82F6
});

test('typography is Inter', async ({ page }) => {
  await page.goto('/setup');
  const ff = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  expect(ff.toLowerCase()).toContain('inter');
});

test('error text renders in #EF4444', async ({ page }) => {
  await page.goto('/setup');
  await page.getByRole('button', { name: /Ja tenho tudo isso/ }).click();
  const input = page.locator('label:has-text("OWNER_EMAIL")').locator('xpath=following::input[1]');
  await input.fill('bad');
  const err = page.getByText('Email invalido.');
  await expect(err).toBeVisible();
  const color = await err.evaluate((el) => getComputedStyle(el).color);
  expect(color).toBe('rgb(239, 68, 68)');
});

test('success text renders in #10B981', async ({ page }) => {
  await page.goto('/setup');
  await page.getByRole('button', { name: /Ja tenho tudo isso/ }).click();
  const input = page.locator('label:has-text("SUPABASE_URL")').locator('xpath=following::input[1]');
  await input.fill(CORE.supabase_url);
  const okMsg = page.getByText('URL valida.');
  await expect(okMsg).toBeVisible();
  const color = await okMsg.evaluate((el) => getComputedStyle(el).color);
  expect(color).toBe('rgb(16, 185, 129)');
});

test('setup card uses backdrop blur (glassmorphism)', async ({ page }) => {
  await page.goto('/setup');
  // The card is the blurred container wrapping the step content.
  const card = page.locator('div.backdrop-blur-\\[40px\\]').first();
  const filter = await card.evaluate(
    (el) => getComputedStyle(el).backdropFilter || (getComputedStyle(el) as any).webkitBackdropFilter,
  );
  expect(filter).toContain('blur(40px)');
});
