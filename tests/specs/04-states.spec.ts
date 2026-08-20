import { test, expect } from '@playwright/test';
import { fillCoreStep2, setScenario, shot } from '../helpers';

async function toStep2(page: import('@playwright/test').Page) {
  await page.goto('/setup');
  await page.getByRole('button', { name: /Ja tenho tudo isso/ }).click();
  await fillCoreStep2(page);
}

test('loading: Step 3 shows the bootstrap timeline with a spinner', async ({ page }) => {
  await setScenario(page, 'default');
  await toStep2(page);
  await page.getByRole('button', { name: 'Configurar' }).click();
  await expect(page.getByRole('heading', { name: 'Setup' })).toBeVisible();
  // While /api/bootstrap is in-flight, at least one step shows the spinner.
  await expect(page.locator('svg.animate-spin').first()).toBeVisible();
  await shot(page, 'state-loading');
});

test('happy path: Step 3 completes and advances to Step 4 (health 200)', async ({ page }) => {
  await setScenario(page, 'default');
  await toStep2(page);
  await page.getByRole('button', { name: 'Configurar' }).click();
  await expect(page.getByRole('heading', { name: 'APIs da aplicacao' })).toBeVisible({ timeout: 15_000 });
});

test('error: failed bootstrap surfaces a toast and a retry control', async ({ page }) => {
  await setScenario(page, 'bootstrap-error');
  await toStep2(page);
  await page.getByRole('button', { name: 'Configurar' }).click();
  await expect(page.getByText('Setup falhou')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: 'Tentar de novo' })).toBeVisible();
  await shot(page, 'state-error');
});

test('deploy pending: Step 3 shows the "waiting for app" notice while health is 503', async ({ page }) => {
  await setScenario(page, 'deploy-pending');
  await toStep2(page);
  await page.getByRole('button', { name: 'Configurar' }).click();
  await expect(page.getByText(/O Vercel esta publicando o novo deployment/)).toBeVisible({ timeout: 10_000 });
  await shot(page, 'state-deploy-pending');
});
