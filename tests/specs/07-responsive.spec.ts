import { test, expect } from '@playwright/test';
import { fillCoreStep2, reachStep4LoggedIn, setScenario, SHOTS } from '../helpers';
import path from 'node:path';

const VIEWPORTS = [
  { name: '375', width: 375, height: 812 },
  { name: '768', width: 768, height: 1024 },
  { name: '1280', width: 1280, height: 900 },
];

for (const vp of VIEWPORTS) {
  test(`@${vp.name}: Step 1 has no horizontal overflow`, async ({ page }) => {
    await setScenario(page, 'default');
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto('/setup');
    await expect(page.getByRole('heading', { name: 'Mega CRM' })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    await page.screenshot({ path: path.join(SHOTS, `resp-step1-${vp.name}.png`), fullPage: true });
    expect(overflow, `horizontal overflow at ${vp.name}px`).toBeLessThanOrEqual(1);
  });

  test(`@${vp.name}: Step 2 has no horizontal overflow`, async ({ page }) => {
    await setScenario(page, 'default');
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto('/setup');
    await page.getByRole('button', { name: /Ja tenho tudo isso/ }).click();
    await expect(page.getByRole('heading', { name: 'Credenciais core' })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    await page.screenshot({ path: path.join(SHOTS, `resp-step2-${vp.name}.png`), fullPage: true });
    expect(overflow, `horizontal overflow at ${vp.name}px`).toBeLessThanOrEqual(1);
  });

  test(`@${vp.name}: Step 4 has no horizontal overflow`, async ({ page }) => {
    await setScenario(page, 'default');
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await reachStep4LoggedIn(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    await page.screenshot({ path: path.join(SHOTS, `resp-step4-${vp.name}.png`), fullPage: true });
    expect(overflow, `horizontal overflow at ${vp.name}px`).toBeLessThanOrEqual(1);
  });
}

test('@375: primary button tap target is >= 44px tall', async ({ page }) => {
  await setScenario(page, 'default');
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/setup');
  const box = await page.getByRole('button', { name: /Ja tenho tudo isso/ }).boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
});
