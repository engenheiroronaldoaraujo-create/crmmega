# Contributing

This is a single-organization, self-hosted build of WhatsApp Hub.

## Local Development

```bash
npm install
npm run dev
```

Production setup is handled by the deployed `/setup` wizard. Do not document
manual student setup flows that require editing `.env`, pasting secrets into
prompts, or pushing Supabase secrets by hand.

## Runtime Credentials

- Core Supabase and crypto envs are set by `/api/bootstrap`.
- Application credentials live in encrypted `public.app_settings` rows.
- Edge Functions read application credentials through
  `supabase/functions/_shared/credentials.ts`.
- Frontend code must never read provider secrets.

## Checks

- Run `npm run build` before opening a PR.
- Run `npm run validate:sql` if migrations changed.
- Keep the dark glassmorphism design system.
