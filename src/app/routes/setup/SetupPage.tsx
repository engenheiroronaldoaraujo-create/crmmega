import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Eye, EyeOff, ExternalLink, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { setupConfig } from '../../../../setup.config';

type Step = 1 | 2 | 3;
type FieldKey =
  | 'supabase_url'
  | 'supabase_anon_key'
  | 'supabase_service_role_key'
  | 'supabase_pat'
  | 'vercel_token'
  | 'owner_email'
  | 'owner_password';

type CoreValues = Record<FieldKey, string>;
type ValidationMap = Partial<Record<FieldKey, { ok: boolean; message: string }>>;

const STORAGE_KEY = 'agentise.setup.step2';
// As chaves de API da aplicação (Zernio/OpenAI/UAZAPI) não fazem mais parte do
// wizard: o bootstrap é o último passo; o usuário entra no CRM e configura as
// credenciais em /settings/credentials.
const STEP_LABELS = ['PREPARAR', 'CREDENCIAIS', 'SETUP'] as const;

// Each Step 3 row maps to the checkpoint that api/bootstrap.ts writes into
// public._bootstrap_state. The wizard hydrates the timeline from those rows so
// a refresh mid-bootstrap shows the real progress instead of restarting blind.
// The final row ('app_live') is NOT a _bootstrap_state checkpoint — it is only
// completed once the health probe confirms the redeploy is live with envs.
const TIMELINE_STEPS: { label: string; key: string }[] = [
  { label: 'Conectando ao Supabase', key: 'connection_ok' },
  { label: 'Rodando migrations', key: 'migrations_done' },
  { label: 'Deployando Edge Functions', key: 'edge_functions_deployed' },
  { label: 'Criando conta de administrador', key: 'owner_created' },
  { label: 'Configurando Vercel', key: 'vercel_envs_set' },
  { label: 'Disparando redeploy', key: 'redeploy_triggered' },
  { label: 'Aguardando aplicacao reiniciar', key: 'app_live' },
];

const HEALTH_POLL_INTERVAL_MS = 4000;
const HEALTH_POLL_TIMEOUT_MS = 5 * 60 * 1000;

const emptyCore: CoreValues = {
  supabase_url: '',
  supabase_anon_key: '',
  supabase_service_role_key: '',
  supabase_pat: '',
  vercel_token: '',
  owner_email: '',
  owner_password: '',
};

function PrimaryButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={[
        'min-h-12 rounded-xl px-8 py-4 text-base font-medium text-white transition-[box-shadow,opacity,transform] duration-[400ms] ease-[cubic-bezier(0.4,0,0.2,1)]',
        'bg-[linear-gradient(135deg,#1E3A8A_0%,#3B82F6_100%)] shadow-[0_8px_40px_rgba(59,130,246,0.4),0_0_60px_rgba(59,130,246,0.2)]',
        'hover:shadow-[0_8px_50px_rgba(59,130,246,0.6),0_0_80px_rgba(59,130,246,0.3)] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none',
        'w-full sm:w-auto',
        props.className ?? '',
      ].join(' ')}
    />
  );
}

function StepIndicator({ step }: { step: Step }) {
  return (
    <div className="mb-10 flex w-full items-start justify-center">
      {STEP_LABELS.map((label, index) => {
        const n = index + 1;
        const active = step === n;
        const complete = step > n;
        return (
          <div key={label} className="flex min-w-0 flex-1 items-start last:flex-none sm:flex-none">
            <div className="flex flex-col items-center">
              <div
                className={[
                  'flex h-10 w-10 items-center justify-center rounded-full text-sm font-semibold',
                  active
                    ? 'bg-[#3B82F6] text-white shadow-[0_0_30px_rgba(59,130,246,0.5)]'
                    : complete
                      ? 'bg-[#1E3A8A] text-white'
                      : 'border border-[rgba(59,130,246,0.3)] bg-transparent text-[#94A3B8]',
                ].join(' ')}
              >
                {complete ? <Check className="h-4 w-4" /> : n}
              </div>
              <div
                className={[
                  'mt-3 whitespace-nowrap text-[11px] font-medium uppercase tracking-[0.1em]',
                  active ? 'text-[#F8FAFC]' : 'text-[#94A3B8]',
                ].join(' ')}
              >
                {label}
              </div>
            </div>
            {index < STEP_LABELS.length - 1 ? (
              <div className="mx-2 mt-5 h-px w-8 border-t border-[rgba(59,130,246,0.2)] sm:mx-5 sm:w-20" />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function SetupCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-[rgba(59,130,246,0.15)] bg-white/[0.02] p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] backdrop-blur-[40px] md:p-12">
      {children}
    </div>
  );
}

function PrepItem({
  n,
  title,
  text,
  href,
  pills,
}: {
  n: number;
  title: string;
  text: string;
  href: string;
  pills: string[];
}) {
  return (
    <div className="relative rounded-xl border border-[rgba(59,130,246,0.12)] bg-white/[0.02] p-5">
      <div className="flex gap-4 pr-16">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[rgba(59,130,246,0.4)] text-sm font-medium text-[#60A5FA]">
          {n}
        </div>
        <div>
          <h2 className="text-base font-semibold text-[#F8FAFC]">{title}</h2>
          <p className="mt-1 text-[13px] leading-5 text-[#94A3B8]">{text}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {pills.map((pill) => (
              <span
                key={pill}
                className="rounded-full border border-[rgba(59,130,246,0.3)] bg-[rgba(30,58,138,0.4)] px-3 py-1 font-mono text-[11px] uppercase tracking-[0.05em] text-[#60A5FA]"
              >
                {pill}
              </span>
            ))}
          </div>
        </div>
      </div>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="absolute right-5 top-5 inline-flex items-center gap-1 text-sm text-[#60A5FA] hover:text-[#85B7EB]"
      >
        abrir
        <ExternalLink className="h-3.5 w-3.5" />
      </a>
    </div>
  );
}

// Network-backed field checks (Supabase keys/PAT, Vercel token) run through
// the server proxy so the tokens never go from the browser to api.supabase.com
// / api.vercel.com directly. Pure-regex fields stay client-side.
async function validateCoreField(
  key: FieldKey,
  value: string,
  context: Record<string, string>,
): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch('/api/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'core', key, value, context }),
    });
    const body = (await res.json()) as { ok: boolean; message?: string };
    return { ok: body.ok, message: body.message ?? '' };
  } catch {
    return { ok: false, message: 'Falha ao validar.' };
  }
}

export default function SetupPage() {
  const [step, setStep] = useState<Step>(() => {
    const value = new URLSearchParams(window.location.search).get('step');
    // ?step=4 era o antigo passo de APIs — hoje o bootstrap encerra o wizard.
    if (value === '3' || value === '4') return 3;
    return 1;
  });
  const [core, setCore] = useState<CoreValues>(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (!saved) return emptyCore;
    return { ...emptyCore, ...JSON.parse(saved), owner_password: '' };
  });
  const [validation, setValidation] = useState<ValidationMap>({});
  // A core field is validated only after the user interacts with it, so a
  // pristine Step 2 never shows red errors before any input. Fields restored
  // from localStorage already carry a value, so we treat them as touched to
  // keep the returning-user flow (auto-validate + enable Configurar) intact.
  const [touched, setTouched] = useState<Partial<Record<FieldKey, boolean>>>(() =>
    Object.fromEntries(
      (Object.keys(core) as FieldKey[])
        .filter((key) => core[key].trim() !== '')
        .map((key) => [key, true]),
    ),
  );
  const [bootstrapping, setBootstrapping] = useState(false);
  const [timeline, setTimeline] = useState<string[]>([]);
  const [showCorePassword, setShowCorePassword] = useState<Record<FieldKey, boolean>>(
    {} as Record<FieldKey, boolean>,
  );
  const [waitingForApp, setWaitingForApp] = useState(false);
  const [setupDone, setSetupDone] = useState(false);
  const [deployTimedOut, setDeployTimedOut] = useState(false);
  const pollingRef = useRef(false);

  useEffect(() => {
    const safe = { ...core, owner_password: '' };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(safe));
  }, [core]);

  useEffect(() => {
    if (step !== 2) return;
    const timers = Object.entries(core).map(([key, value]) =>
      window.setTimeout(async () => {
        const field = key as FieldKey;
        if (!touched[field]) return;
        const v = value.trim();
        let result = { ok: true, message: '' };
        if (field === 'supabase_url') {
          result = /^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/i.test(v)
            ? { ok: true, message: 'URL valida.' }
            : { ok: false, message: 'Use https://xxxxx.supabase.co' };
        } else if (field === 'supabase_anon_key' || field === 'supabase_service_role_key') {
          result = v && core.supabase_url
            ? await validateCoreField(field, v, { supabase_url: core.supabase_url })
            : { ok: false, message: 'Preencha URL e chave.' };
        } else if (field === 'supabase_pat') {
          result = v
            ? await validateCoreField(field, v, {})
            : { ok: false, message: 'Informe o PAT.' };
        } else if (field === 'vercel_token') {
          result = v
            ? await validateCoreField(field, v, {})
            : { ok: false, message: 'Informe o token Vercel.' };
        } else if (field === 'owner_email') {
          result = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)
            ? { ok: true, message: 'Email valido.' }
            : { ok: false, message: 'Email invalido.' };
        } else if (field === 'owner_password') {
          result = /^(?=.*[A-Za-z])(?=.*\d).{8,}$/.test(v)
            ? { ok: true, message: 'Senha valida.' }
            : { ok: false, message: 'Minimo 8 caracteres, com letra e numero.' };
        }
        setValidation((prev) => ({ ...prev, [field]: result }));
      }, 800),
    );
    return () => timers.forEach(window.clearTimeout);
  }, [core, step, touched]);

  const coreReady = useMemo(
    () =>
      ([
        'supabase_url',
        'supabase_anon_key',
        'supabase_service_role_key',
        'supabase_pat',
        'vercel_token',
        'owner_email',
        'owner_password',
      ] as FieldKey[]).every((key) => validation[key]?.ok),
    [validation],
  );

  // The redeploy that api/bootstrap fires only activates the core envs in a NEW
  // deployment. We poll the app's own /api/health (same-origin, no VERCEL_TOKEN)
  // until it reports 200 — meaning process.env.SUPABASE_URL is live. Depois
  // disso o setup está completo: o usuário entra no CRM e configura as chaves
  // de API em /settings/credentials.
  const waitForAppLive = useCallback(async () => {
    if (pollingRef.current) return;
    pollingRef.current = true;
    setWaitingForApp(true);
    setDeployTimedOut(false);
    setTimeline(TIMELINE_STEPS.slice(0, 6).map((entry) => entry.label));
    const deadline = Date.now() + HEALTH_POLL_TIMEOUT_MS;
    try {
      while (Date.now() < deadline) {
        try {
          const res = await fetch(`${window.location.origin}/api/health`, { cache: 'no-store' });
          if (res.ok) {
            setTimeline(TIMELINE_STEPS.map((entry) => entry.label));
            window.localStorage.removeItem(STORAGE_KEY);
            setSetupDone(true);
            return;
          }
        } catch {
          // Network blips are expected while the production alias swaps over.
        }
        await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
      }
      setDeployTimedOut(true);
    } finally {
      setWaitingForApp(false);
      pollingRef.current = false;
    }
  }, []);

  // On (re)entering Step 3 while not actively bootstrapping — e.g. after a
  // refresh — read public._bootstrap_state and reflect completed checkpoints in
  // the timeline so the user sees where the run stopped. If the redeploy was
  // already triggered, resume polling for the app to come live.
  useEffect(() => {
    if (step !== 3 || bootstrapping) return;
    if (!core.supabase_url || !core.supabase_pat) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/bootstrap-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ supabase_url: core.supabase_url, supabase_pat: core.supabase_pat }),
        });
        const body = (await res.json()) as { completed?: string[] };
        if (cancelled || !Array.isArray(body.completed)) return;
        const done = new Set(body.completed);
        setTimeline(
          TIMELINE_STEPS.filter((entry) => done.has(entry.key)).map((entry) => entry.label),
        );
        if (done.has('redeploy_triggered')) void waitForAppLive();
      } catch {
        // Leave the timeline empty; the user can still retry.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [step, bootstrapping, core.supabase_url, core.supabase_pat, waitForAppLive]);

  const runBootstrap = async () => {
    setStep(3);
    // Keep ?step=3 in the URL so a refresh mid-bootstrap returns here (and
    // re-hydrates from _bootstrap_state) instead of bouncing back to Step 1.
    window.history.replaceState(null, '', '/setup?step=3');
    setBootstrapping(true);
    setDeployTimedOut(false);
    setTimeline(['Conectando ao Supabase']);
    try {
      const res = await fetch('/api/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(core),
      });
      const body = await res.json();
      if (!res.ok || !body.success) throw new Error(body.message ?? 'Setup falhou.');
      toast.success('Setup concluido. Aguardando o app reiniciar...');
      // Don't jump to Step 4 yet — wait for the redeploy to bring the envs live.
      await waitForAppLive();
    } catch (err) {
      const raw = err instanceof Error ? err.message : 'Erro interno';
      // Rate limit da Management API do Supabase: o progresso fica salvo em
      // _bootstrap_state, então o retry retoma de onde parou.
      const throttled = raw.includes('429') || raw.includes('ThrottlerException');
      toast.error('Setup falhou', {
        description: throttled
          ? 'Limite de requisições do Supabase atingido. Aguarde ~1 minuto e clique em "Tentar de novo" — o progresso é retomado de onde parou.'
          : raw,
      });
    } finally {
      setBootstrapping(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0A0A0F] px-4 py-8 text-[#F8FAFC] md:py-12">
      <div className="mx-auto w-full max-w-[760px]">
        <StepIndicator step={step} />
        <SetupCard>
          {step === 1 ? (
            <>
              <h1 className="mb-2 text-[28px] font-semibold text-[#F8FAFC]">{setupConfig.toolName}</h1>
              <p className="mb-8 text-base leading-[1.6] text-[#94A3B8]">
                Antes de iniciar, deixe abertas as contas onde voce vai copiar os tokens de bootstrap.
              </p>
              <div className="space-y-4">
                <PrepItem n={1} title="Criar projeto Supabase" text="Crie um projeto vazio e copie URL, anon key e service role key." href="https://supabase.com/dashboard/new" pills={['SUPABASE_URL', 'ANON_KEY', 'SERVICE_ROLE']} />
                <PrepItem n={2} title="Gerar PAT Supabase" text="Crie um Personal Access Token para rodar migrations e deployar Edge Functions." href="https://supabase.com/dashboard/account/tokens" pills={['SUPABASE_PAT']} />
                <PrepItem n={3} title="Gerar Vercel Token" text="Crie um token para o wizard configurar envs core e disparar o redeploy." href="https://vercel.com/account/tokens" pills={['VERCEL_TOKEN']} />
              </div>
              <div className="mt-8 flex justify-end">
                <PrimaryButton onClick={() => setStep(2)}>Ja tenho tudo isso, continuar</PrimaryButton>
              </div>
            </>
          ) : null}

          {step === 2 ? (
            <>
              <h1 className="mb-2 text-[28px] font-semibold text-[#F8FAFC]">Credenciais core</h1>
              <p className="mb-8 text-base leading-[1.6] text-[#94A3B8]">
                Estas credenciais sao usadas uma vez para preparar a instancia. Senha do owner nao fica salva.
              </p>
              <div className="grid gap-4">
                {(Object.keys(emptyCore) as FieldKey[]).map((key) => {
                  const isSecret = key.includes('key') || key.includes('token') || key.includes('password');
                  const revealed = showCorePassword[key];
                  return (
                    <div key={key}>
                      <label className="mb-1.5 block text-[13px] font-medium text-[#CBD5E1]">
                        {key.toUpperCase()}
                      </label>
                      <div className="relative">
                        <input
                          type={isSecret && !revealed ? 'password' : 'text'}
                          value={core[key]}
                          onChange={(event) => {
                            const next = event.target.value;
                            setTouched((prev) => ({ ...prev, [key]: true }));
                            setCore((prev) => ({ ...prev, [key]: next }));
                          }}
                          autoComplete={key === 'owner_password' ? 'new-password' : 'off'}
                          className="w-full rounded-lg border border-[rgba(59,130,246,0.2)] bg-white/[0.03] px-4 py-3 pr-16 text-sm text-[#F8FAFC] placeholder:text-[#94A3B8] focus:border-[#3B82F6] focus:outline-none focus:shadow-[0_0_20px_rgba(59,130,246,0.2)]"
                        />
                        <div className="absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-2">
                          {isSecret ? (
                            <button
                              type="button"
                              aria-label={revealed ? 'Ocultar' : 'Mostrar'}
                              onClick={() => setShowCorePassword((prev) => ({ ...prev, [key]: !prev[key] }))}
                              className="text-[#94A3B8] hover:text-[#F8FAFC]"
                            >
                              {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                            </button>
                          ) : null}
                          {validation[key]?.ok ? <Check className="h-4 w-4 text-[#10B981]" /> : validation[key] ? <X className="h-4 w-4 text-[#EF4444]" /> : null}
                        </div>
                      </div>
                      {validation[key]?.message ? (
                        <p className={validation[key]?.ok ? 'mt-1 text-xs text-[#10B981]' : 'mt-1 text-xs text-[#EF4444]'}>
                          {validation[key]?.message}
                        </p>
                      ) : null}
                    </div>
                  );
                })}
              </div>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <button
                  type="button"
                  onClick={() => setStep(1)}
                  className="min-h-11 w-full rounded-lg border border-[rgba(59,130,246,0.25)] bg-white/[0.03] px-5 text-sm font-medium text-[#F8FAFC] transition hover:border-[#3B82F6] sm:w-auto"
                >
                  Voltar
                </button>
                <PrimaryButton disabled={!coreReady || bootstrapping} onClick={runBootstrap}>
                  Configurar
                </PrimaryButton>
              </div>
            </>
          ) : null}

          {step === 3 ? (
            <>
              <h1 className="mb-2 text-[28px] font-semibold text-[#F8FAFC]">Setup</h1>
              <p className="mb-8 text-base leading-[1.6] text-[#94A3B8]">
                Preparando Supabase, Edge Functions, owner e Vercel.
              </p>
              <div className="space-y-3">
                {TIMELINE_STEPS.map((entry) => (
                  <div key={entry.label} className="flex items-center gap-3 rounded-xl border border-[rgba(59,130,246,0.12)] bg-white/[0.02] p-4">
                    {timeline.includes(entry.label) ? <Check className="h-5 w-5 text-[#10B981]" /> : <Loader2 className="h-5 w-5 animate-spin text-[#60A5FA]" />}
                    <span className="text-sm text-[#F8FAFC]">{entry.label}</span>
                  </div>
                ))}
              </div>
              {waitingForApp ? (
                <p className="mt-6 text-center text-sm text-[#94A3B8]">
                  O Vercel esta publicando o novo deployment com as envs. Isso pode levar alguns minutos.
                </p>
              ) : null}

              {setupDone ? (
                <div className="mt-8 rounded-xl border border-[rgba(16,185,129,0.3)] bg-[rgba(16,185,129,0.06)] p-5">
                  <p className="text-sm leading-5 text-[#F8FAFC]">
                    Setup concluido! Entre no CRM com o e-mail e a senha do owner. As chaves de
                    API (Zernio, OpenAI, UAZAPI) sao configuradas depois, em Configuracoes →
                    Credenciais.
                  </p>
                  <div className="mt-4 flex justify-end">
                    <PrimaryButton onClick={() => { window.location.href = '/auth/login'; }}>
                      Entrar no CRM
                    </PrimaryButton>
                  </div>
                </div>
              ) : null}

              {deployTimedOut ? (
                <div className="mt-8 rounded-xl border border-[rgba(239,68,68,0.3)] bg-[rgba(239,68,68,0.06)] p-5">
                  <p className="text-sm leading-5 text-[#F8FAFC]">
                    O redeploy esta demorando mais que o esperado. Verifique o status em{' '}
                    <a
                      href="https://vercel.com/dashboard"
                      target="_blank"
                      rel="noreferrer"
                      className="text-[#60A5FA] underline hover:text-[#85B7EB]"
                    >
                      vercel.com/dashboard
                    </a>
                    . Quando o app estiver no ar, continue.
                  </p>
                  <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:justify-end">
                    <button
                      type="button"
                      onClick={() => void waitForAppLive()}
                      className="min-h-11 rounded-lg border border-[rgba(59,130,246,0.25)] bg-white/[0.03] px-5 text-sm font-medium text-[#F8FAFC] transition hover:border-[#3B82F6]"
                    >
                      Verificar de novo
                    </button>
                    <PrimaryButton onClick={() => { window.localStorage.removeItem(STORAGE_KEY); window.location.href = '/auth/login'; }}>
                      Continuar mesmo assim
                    </PrimaryButton>
                  </div>
                </div>
              ) : !setupDone && !bootstrapping && !waitingForApp ? (
                <div className="mt-8 space-y-3">
                  {!core.owner_password ? (
                    <div>
                      <label className="mb-1.5 block text-[13px] font-medium text-[#CBD5E1]">
                        Reinforme a senha do owner para retomar
                      </label>
                      <input
                        type="password"
                        value={core.owner_password}
                        onChange={(event) => setCore((prev) => ({ ...prev, owner_password: event.target.value }))}
                        placeholder="senha do owner"
                        autoComplete="current-password"
                        className="w-full rounded-lg border border-[rgba(59,130,246,0.2)] bg-white/[0.03] px-4 py-3 text-sm text-[#F8FAFC] placeholder:text-[#94A3B8] focus:border-[#3B82F6] focus:outline-none focus:shadow-[0_0_20px_rgba(59,130,246,0.2)]"
                      />
                    </div>
                  ) : null}
                  <div className="flex justify-end">
                    <PrimaryButton disabled={!core.owner_password} onClick={runBootstrap}>Tentar de novo</PrimaryButton>
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
        </SetupCard>
      </div>
    </div>
  );
}
