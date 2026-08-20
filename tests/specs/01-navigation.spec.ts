import { test, expect } from '@playwright/test';
import { fillCoreStep2, setScenario, shot } from '../helpers';

test.beforeEach(async ({ page }) => setScenario(page, 'default'));

test('Step 1 renders prep cards and the only action is advance', async ({ page }) => {
  await page.goto('/setup');
  await expect(page.getByRole('heading', { name: 'Mega CRM' })).toBeVisible();
  await expect(page.getByText('Criar projeto Supabase')).toBeVisible();
  await expect(page.getByText('Gerar PAT Supabase')).toBeVisible();
  await expect(page.getByText('Gerar Vercel Token')).toBeVisible();
  await shot(page, 'step1');
  // Step indicator shows step 1 active.
  await expect(page.getByText('PREPARAR')).toBeVisible();
});

test('Step 1 -> Step 2 forward navigation works', async ({ page }) => {
  await page.goto('/setup');
  await page.getByRole('button', { name: /Ja tenho tudo isso/ }).click();
  await expect(page.getByRole('heading', { name: 'Credenciais core' })).toBeVisible();
  await shot(page, 'step2');
});

test('Configurar is disabled until all core fields are valid (cannot skip Step 2)', async ({ page }) => {
  await page.goto('/setup');
  await page.getByRole('button', { name: /Ja tenho tudo isso/ }).click();
  // Without valid input, the advance button is disabled -> required step cannot be skipped.
  await expect(page.getByRole('button', { name: 'Configurar' })).toBeDisabled();
  await fillCoreStep2(page);
  await expect(page.getByRole('button', { name: 'Configurar' })).toBeEnabled();
});

test('Step 2 -> Step 3 advances on Configurar', async ({ page }) => {
  await page.goto('/setup');
  await page.getByRole('button', { name: /Ja tenho tudo isso/ }).click();
  await fillCoreStep2(page);
  await page.getByRole('button', { name: 'Configurar' }).click();
  await expect(page.getByRole('heading', { name: 'Setup' })).toBeVisible();
  await shot(page, 'step3');
});

test('Step 2 -> Step 1 backward navigation works (Voltar)', async ({ page }) => {
  await page.goto('/setup');
  await page.getByRole('button', { name: /Ja tenho tudo isso/ }).click();
  await expect(page.getByRole('heading', { name: 'Credenciais core' })).toBeVisible();
  await page.getByRole('button', { name: 'Voltar' }).click();
  await expect(page.getByRole('heading', { name: 'Mega CRM' })).toBeVisible();
});

test('direct deep-link to ?step=4 shows owner login gate (cannot jump past auth)', async ({ page }) => {
  await page.goto('/setup?step=4');
  await expect(page.getByRole('heading', { name: 'APIs da aplicacao' })).toBeVisible();
  await expect(page.getByText('Confirme o login do owner')).toBeVisible();
  await shot(page, 'step4-login');
});
