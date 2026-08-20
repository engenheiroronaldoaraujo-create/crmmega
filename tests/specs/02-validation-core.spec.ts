import { test, expect } from '@playwright/test';
import { CORE, setScenario } from '../helpers';

test.beforeEach(async ({ page }) => {
  await setScenario(page, 'default');
  await page.goto('/setup');
  await page.getByRole('button', { name: /Ja tenho tudo isso/ }).click();
  await expect(page.getByRole('heading', { name: 'Credenciais core' })).toBeVisible();
});

function inputFor(page: import('@playwright/test').Page, key: string) {
  return page.locator(`label:has-text("${key.toUpperCase()}")`).locator('xpath=following::input[1]');
}

test('invalid SUPABASE_URL shows pt-BR error', async ({ page }) => {
  await inputFor(page, 'supabase_url').fill('ftp://not-supabase');
  await expect(page.getByText('Use https://xxxxx.supabase.co')).toBeVisible({ timeout: 4000 });
});

test('valid SUPABASE_URL shows success message', async ({ page }) => {
  await inputFor(page, 'supabase_url').fill(CORE.supabase_url);
  await expect(page.getByText('URL valida.')).toBeVisible({ timeout: 4000 });
});

test('invalid OWNER_EMAIL shows pt-BR error', async ({ page }) => {
  await inputFor(page, 'owner_email').fill('not-an-email');
  await expect(page.getByText('Email invalido.')).toBeVisible({ timeout: 4000 });
});

test('weak OWNER_PASSWORD shows pt-BR rule', async ({ page }) => {
  await inputFor(page, 'owner_password').fill('abc');
  await expect(page.getByText('Minimo 8 caracteres, com letra e numero.')).toBeVisible({ timeout: 4000 });
});

test('touched-then-empty network fields surface their pt-BR prompts', async ({ page }) => {
  // Interact then clear to exercise the empty-required path post-interaction.
  await inputFor(page, 'supabase_url').fill(CORE.supabase_url);
  for (const key of ['supabase_anon_key', 'supabase_pat', 'vercel_token']) {
    const input = inputFor(page, key);
    await input.fill('x');
    await input.fill('');
  }
  await expect(page.getByText('Preencha URL e chave.').first()).toBeVisible({ timeout: 4000 });
  await expect(page.getByText('Informe o PAT.')).toBeVisible({ timeout: 4000 });
  await expect(page.getByText('Informe o token Vercel.')).toBeVisible({ timeout: 4000 });
});

test('pristine Step 2 shows NO validation errors before interaction', async ({ page }) => {
  // Give the 800ms debounce ample time; an untouched form must stay silent.
  await page.waitForTimeout(1300);
  await expect(page.locator('p.text-\\[\\#EF4444\\]')).toHaveCount(0);
});

test('touching one field does not reveal errors on the others', async ({ page }) => {
  await inputFor(page, 'owner_email').fill('not-an-email');
  await expect(page.getByText('Email invalido.')).toBeVisible({ timeout: 4000 });
  // Only the touched field reports; the rest remain silent.
  await expect(page.locator('p.text-\\[\\#EF4444\\]')).toHaveCount(1);
});
