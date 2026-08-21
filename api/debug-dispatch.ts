import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '../src/lib/admin-auth.js';

type ApiRequest = {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
};

type ApiResponse = {
  status: (code: number) => ApiResponse;
  json: (body: unknown) => void;
};

export default async function handler(req: ApiRequest, res: ApiResponse) {
  try {
    if (req.method !== 'POST') return res.status(405).end();

    const auth = await requireAdmin(req.headers?.authorization ?? req.headers?.Authorization);
    if (!auth.ok) {
      return res.status(auth.status).json({ success: false, message: auth.message });
    }

    const url = process.env.SUPABASE_URL;
    const srKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !srKey) {
      return res.status(500).json({ success: false, message: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes' });
    }

    const fnRes = await fetch(`${url}/functions/v1/dispatch-campaign`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${srKey}`,
      },
      body: '{}',
    });

    const json = await fnRes.json().catch(() => ({}));
    return res.status(fnRes.status).json(json);
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : 'Erro interno',
    });
  }
}
