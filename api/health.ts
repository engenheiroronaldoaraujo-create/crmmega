// Readiness probe usado pelo wizard /setup. Depois do bootstrap disparar o
// redeploy do Vercel, as envs core só ficam ativas no novo deployment. O Step 3
// faz polling same-origin aqui (sem VERCEL_TOKEN no caminho) até receber 200,
// o que sinaliza que o deployment novo — com as envs — está no ar.
//
// Testa o sintoma real (env ativa em runtime), não o estado do build na Vercel.
// Nunca retorna segredos.

type ApiRequest = { method?: string };

type ApiResponse = {
  status: (code: number) => ApiResponse;
  json: (body: unknown) => void;
  end: () => void;
};

export default function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method && req.method !== 'GET') return res.status(405).end();
  const ready = Boolean(process.env.SUPABASE_URL);
  return res.status(ready ? 200 : 503).json({ ready });
}
