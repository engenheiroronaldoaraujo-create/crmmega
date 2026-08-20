import { test, expect } from '@playwright/test';
import { fillCoreStep2, setScenario } from '../helpers';

const BUDGET_MS = 2000;

test('per-screen load timing (flag > 2s)', async ({ page }) => {
  await setScenario(page, 'default');
  const timings: Record<string, number> = {};

  let t = Date.now();
  await page.goto('/setup');
  await expect(page.getByRole('heading', { name: 'Mega CRM' })).toBeVisible();
  timings['step1'] = Date.now() - t;

  t = Date.now();
  await page.getByRole('button', { name: /Ja tenho tudo isso/ }).click();
  await expect(page.getByRole('heading', { name: 'Credenciais core' })).toBeVisible();
  timings['step2'] = Date.now() - t;

  await fillCoreStep2(page);
  t = Date.now();
  await page.getByRole('button', { name: 'Configurar' }).click();
  await expect(page.getByRole('heading', { name: 'Setup' })).toBeVisible();
  timings['step3'] = Date.now() - t;

  t = Date.now();
  await expect(page.getByRole('heading', { name: 'APIs da aplicacao' })).toBeVisible({ timeout: 15_000 });
  timings['step4(after bootstrap+health)'] = Date.now() - t;

  for (const [screen, ms] of Object.entries(timings)) {
    test.info().annotations.push({
      type: ms > BUDGET_MS ? 'SLOW(>2s)' : 'timing',
      description: `${screen}: ${ms}ms`,
    });
  }

  // Pure UI transitions (step1/step2/step3-render) must be well under budget.
  expect(timings['step1']).toBeLessThan(BUDGET_MS);
  expect(timings['step2']).toBeLessThan(BUDGET_MS);
});
