import { Page, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// Synthetic, FORMAT-VALID core credentials. They pass the wizard's client-side
// regexes and the offline shim accepts the network-backed ones. No real creds.
export const CORE = {
  supabase_url: 'https://demoproject.supabase.co',
  supabase_anon_key: 'anon_demo_key_0123456789',
  supabase_service_role_key: 'service_demo_key_0123456789',
  supabase_pat: 'sbp_demo_personal_access_token_0123456789',
  vercel_token: 'vrc_demo_token_0123456789',
  owner_email: 'owner@example.com',
  owner_password: 'Passw0rd123',
};

export const SHOTS = path.resolve('tests/.artifacts/screens');
fs.mkdirSync(SHOTS, { recursive: true });

export async function setScenario(page: Page, scenario: string) {
  await page.setExtraHTTPHeaders({ 'x-shim-scenario': scenario });
}

// Stub Supabase GoTrue sign-in so Step 4 can mint an owner session offline.
export async function stubOwnerLogin(page: Page, opts: { fail?: boolean } = {}) {
  await page.route('**/auth/v1/token**', async (route) => {
    if (opts.fail) {
      return route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid login credentials' }),
      });
    }
    const session = {
      access_token: 'fake.owner.jwt',
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: 9999999999,
      refresh_token: 'fake-refresh',
      user: {
        id: '00000000-0000-0000-0000-000000000001',
        aud: 'authenticated',
        role: 'authenticated',
        email: CORE.owner_email,
        app_metadata: { role: 'admin' },
        user_metadata: {},
        created_at: '2026-01-01T00:00:00Z',
      },
    };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(session) });
  });
}

// Time how long the wizard card takes to become visible after a navigation.
export async function timeScreen(page: Page, action: () => Promise<void>, marker: () => Promise<void>) {
  const start = Date.now();
  await action();
  await marker();
  return Date.now() - start;
}

// Fill Step 2 with valid core values and wait until "Configurar" is enabled.
export async function fillCoreStep2(page: Page) {
  const setField = async (key: keyof typeof CORE) => {
    const input = page.locator(`label:has-text("${key.toUpperCase()}")`).locator('xpath=following::input[1]');
    await input.fill(CORE[key]);
  };
  for (const key of Object.keys(CORE) as (keyof typeof CORE)[]) {
    await setField(key);
  }
  // Debounced validation (800ms) + shim round-trips must settle.
  const configurar = page.getByRole('button', { name: 'Configurar' });
  await expect(configurar).toBeEnabled({ timeout: 10_000 });
}

export async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

// Reach Step 4 with an owner session minted via the stubbed GoTrue endpoint.
export async function reachStep4LoggedIn(page: Page) {
  await stubOwnerLogin(page);
  // Step 4 lands after a full reload, so the wizard reads core from localStorage.
  // The owner login builds a Supabase client from core.supabase_url/anon_key —
  // seed them so createClient is valid and the stubbed GoTrue route is hit.
  await page.addInitScript((core) => {
    window.localStorage.setItem(
      'agentise.setup.step2',
      JSON.stringify({
        supabase_url: core.supabase_url,
        supabase_anon_key: core.supabase_anon_key,
        owner_email: core.owner_email,
      }),
    );
  }, CORE);
  await page.goto('/setup?step=4');
  await expect(page.getByRole('heading', { name: 'APIs da aplicacao' })).toBeVisible();
  await page.getByPlaceholder('email do owner').fill(CORE.owner_email);
  await page.getByPlaceholder('senha do owner').fill(CORE.owner_password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  // Owner token set -> credential fields render.
  await expect(page.getByText('Meta Phone Number ID', { exact: true })).toBeVisible();
}

// Type into a Step-4 app credential field and return its inline message text.
export async function appFieldMessage(page: Page, key: string, value: string) {
  const input = page.locator(`#${key}`);
  await input.fill(value);
  // debounce 800ms + shim round-trip
  await page.waitForTimeout(1100);
}

export async function consoleErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}
