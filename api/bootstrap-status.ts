// Read-only companion to api/bootstrap.ts. The wizard calls this when it lands
// on Step 3 (including after a refresh) to hydrate the timeline from the
// idempotent _bootstrap_state checkpoints. It only SELECTs step names; it never
// mutates anything and never returns credentials.

type ApiRequest = {
  method?: string;
  body?: { supabase_url?: string; supabase_pat?: string };
};

type ApiResponse = {
  status: (code: number) => ApiResponse;
  json: (body: unknown) => void;
  end: () => void;
};

function projectRef(url: string) {
  const match = url.match(/^https:\/\/([a-z0-9-]+)\.supabase\.(?:co|in)$/i);
  if (!match) throw new Error('SUPABASE_URL invalida.');
  return match[1];
}

async function supabaseQuery(ref: string, pat: string, query: string) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase database/query ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();
  try {
    const { supabase_url, supabase_pat } = req.body ?? {};
    if (!supabase_url || !supabase_pat) return res.status(200).json({ completed: [] });
    const ref = projectRef(supabase_url);
    const rows = await supabaseQuery(
      ref,
      supabase_pat,
      `SELECT step FROM public._bootstrap_state;`,
    );
    const completed = Array.isArray(rows)
      ? rows.map((row: { step: string }) => row.step)
      : [];
    return res.status(200).json({ completed });
  } catch {
    // Table missing / invalid PAT / project unreachable → nothing completed yet.
    return res.status(200).json({ completed: [] });
  }
}
