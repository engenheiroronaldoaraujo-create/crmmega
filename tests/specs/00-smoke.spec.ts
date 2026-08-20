import { test, expect } from '@playwright/test';
import { fillCoreStep2, setScenario } from '../helpers';

test('harness: Step 1 renders and advances to Step 2', async ({ page }) => {
  await setScenario(page, 'default');
  await page.goto('/setup');
  await expect(page.getByRole('heading', { name: 'Mega CRM' })).toBeVisible();
  await page.getByRole('button', { name: /Ja tenho tudo isso/ }).click();
  await expect(page.getByRole('heading', { name: 'Credenciais core' })).toBeVisible();
});

test('harness: core fields validate and enable Configurar', async ({ page }) => {
  await setScenario(page, 'default');
  await page.goto('/setup');
  await page.getByRole('button', { name: /Ja tenho tudo isso/ }).click();
  await fillCoreStep2(page);
  await expect(page.getByRole('button', { name: 'Configurar' })).toBeEnabled();
});
