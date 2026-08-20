import { test, expect } from '@playwright/test';
import { CORE, setScenario, shot } from '../helpers';

// Re-opening /setup for an already-configured project must hydrate from the
// idempotent _bootstrap_state checkpoints WITHOUT re-running the real bootstrap.
test('re-opening Step 3 on a configured project hydrates without re-bootstrapping', async ({ page }) => {
  await setScenario(page, 'idempotent');

  // Seed the persisted core (what the wizard writes to localStorage after Step 2).
  await page.addInitScript((core) => {
    window.localStorage.setItem(
      'agentise.setup.step2',
      JSON.stringify({
        supabase_url: core.supabase_url,
        supabase_pat: core.supabase_pat,
        supabase_anon_key: core.supabase_anon_key,
        supabase_service_role_key: core.supabase_service_role_key,
        vercel_token: core.vercel_token,
        owner_email: core.owner_email,
      }),
    );
  }, CORE);

  const calls: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/api/')) calls.push(`${r.method()} ${u.pathname}`);
  });

  await page.goto('/setup?step=3');
  await expect(page.getByRole('heading', { name: 'Setup' })).toBeVisible();
  await shot(page, 'idempotent-step3');

  // The status route is consulted...
  await expect.poll(() => calls.some((c) => c.includes('/api/bootstrap-status'))).toBe(true);

  // ...and with redeploy already done + health 200 it advances to Step 4.
  await expect(page.getByRole('heading', { name: 'APIs da aplicacao' })).toBeVisible({ timeout: 15_000 });

  // CRITICAL: the destructive bootstrap was never re-invoked.
  expect(calls.some((c) => c === 'POST /api/bootstrap')).toBe(false);
});
