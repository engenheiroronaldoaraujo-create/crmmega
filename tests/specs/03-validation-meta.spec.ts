import { test, expect } from '@playwright/test';
import { reachStep4LoggedIn, appFieldMessage, setScenario, shot } from '../helpers';

// NOTE: no real Meta/WABA token is ever used. We exercise ONLY the field-level
// validation: empty (guard) and bad-format (clear pt-BR error). The format-valid
// "ping" path is also safe — the offline fetch guard answers it 401, so the real
// validator returns its rejection message without contacting Meta.

test.beforeEach(async ({ page }) => {
  await setScenario(page, 'default');
  await reachStep4LoggedIn(page);
});

test('Step 4: Salvar is disabled while required fields are empty (cannot skip)', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Salvar e finalizar' })).toBeDisabled();
  await shot(page, 'step4-fields');
});

test('Meta connection check: bad format -> clear pt-BR error (no real token)', async ({ page }) => {
  await appFieldMessage(page, 'meta_connection_check', 'garbage-no-pipe');
  await expect(
    page.getByText('Use o formato PHONE_NUMBER_ID|ACCESS_TOKEN para validar na Meta.'),
  ).toBeVisible();
});

test('Meta connection check: well-formed but rejected offline -> Meta-invalid error', async ({ page }) => {
  await appFieldMessage(page, 'meta_connection_check', '123456789012345|EAAfaketoken');
  await expect(page.getByText('Phone Number ID ou token Meta invalido.')).toBeVisible();
});

test('Meta Tier: invalid value -> clear pt-BR error', async ({ page }) => {
  await appFieldMessage(page, 'meta_tier', 'tier_999');
  await expect(page.getByText('Use tier_250, tier_1k, tier_10k ou tier_100k.')).toBeVisible();
});

test('Meta Webhook Verify Token: too short -> clear pt-BR error', async ({ page }) => {
  await appFieldMessage(page, 'meta_webhook_verify_token', 'short');
  await expect(page.getByText('Use um token com pelo menos 16 caracteres.')).toBeVisible();
});

test('LLM Provider: invalid value -> clear pt-BR error', async ({ page }) => {
  await appFieldMessage(page, 'llm_provider', 'mistral');
  await expect(page.getByText('Use openai, claude ou gemini.')).toBeVisible();
});

test('App URL: non-HTTPS -> clear pt-BR error', async ({ page }) => {
  await appFieldMessage(page, 'app_url', 'meu-app.com');
  await expect(page.getByText('Informe uma URL HTTPS publica.')).toBeVisible();
});
