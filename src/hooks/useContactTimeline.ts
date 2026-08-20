import { useCallback, useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase';
import { CRM_ACTION_LABEL, CRM_ACTION_TYPES, type CrmActionType } from '@/types/crm';

export type TimelineEntryKind =
  | 'conversa'
  | 'mudanca_estagio'
  | 'nota'
  | 'ganho'
  | 'perdido'
  | 'acao_agendada'
  | 'acao_concluida';

export interface TimelineEntry {
  id: string;
  kind: TimelineEntryKind;
  label: string;
  text: string;
  at: string;
  channel?: string | null;
  author_id?: string | null;
}

export interface DayGroup {
  date: string; // YYYY-MM-DD
  entries: TimelineEntry[];
}

const CHANNEL_LABEL: Record<string, string> = { whatsapp: 'WhatsApp', instagram: 'Instagram', sistema: 'Sistema' };

// Timeline agrupada por DATA (Módulo 5.3): conversas (contadas por dia/canal),
// mudanças de estágio (IA/humano) e notas por interação. Computada on-read.
export function useContactTimeline(contactId: string) {
  const [groups, setGroups] = useState<DayGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!contactId) return;
    setLoading(true);
    setError(null);
    const supabase = getSupabase();

    // Conversas do contato (todos os canais) e deals (para o histórico de estágio).
    const [{ data: convs }, { data: dealsRows }, { data: stagesRows }] = await Promise.all([
      supabase.from('conversations').select('id, channel').eq('contact_id', contactId),
      supabase.from('deals').select('id, title, status, won_at, lost_at, lost_reason').eq('contact_id', contactId),
      supabase.from('stages').select('id, name'),
    ]);
    const convChannel = new Map<string, string>();
    for (const c of (convs ?? []) as Array<{ id: string; channel: string }>) convChannel.set(c.id, c.channel);
    const convIds = Array.from(convChannel.keys());
    const dealList = (dealsRows ?? []) as Array<{
      id: string; title: string; status: string; won_at: string | null; lost_at: string | null; lost_reason: string | null;
    }>;
    const dealIds = dealList.map((d) => d.id);
    const dealTitleById = new Map<string, string>();
    for (const d of dealList) dealTitleById.set(d.id, d.title);
    const stageName = new Map<string, string>();
    for (const s of (stagesRows ?? []) as Array<{ id: string; name: string }>) stageName.set(s.id, s.name);

    const fmtDue = (s: string) =>
      new Date(s).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

    const [msgsRes, histRes, interRes, actsRes] = await Promise.all([
      convIds.length
        ? supabase
            .from('messages')
            .select('conversation_id, created_at, direction, is_private_note')
            .in('conversation_id', convIds)
            .order('created_at', { ascending: false })
            .limit(1000)
        : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
      dealIds.length
        ? supabase
            .from('lead_stage_history')
            .select('id, to_stage_id, from_stage_id, moved_by, reason, created_at')
            .in('deal_id', dealIds)
            .order('created_at', { ascending: false })
        : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
      supabase
        .from('contact_interactions')
        .select('id, interaction_date, channel, summary, event_type, created_at, interaction_notes(id, note, author_id, created_at)')
        .eq('contact_id', contactId)
        .order('interaction_date', { ascending: false }),
      dealIds.length
        ? supabase
            .from('crm_activities')
            .select('id, deal_id, type, title, body, due_at, done, done_at, created_at')
            .in('deal_id', dealIds)
            .in('type', CRM_ACTION_TYPES)
            .not('due_at', 'is', null)
            .order('created_at', { ascending: false })
        : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
    ]);

    const dayMap = new Map<string, TimelineEntry[]>();
    const push = (date: string, entry: TimelineEntry) => {
      const arr = dayMap.get(date) ?? [];
      arr.push(entry);
      dayMap.set(date, arr);
    };

    // 1. Mensagens → agregadas por dia + canal (conta só as não-privadas).
    const msgAgg = new Map<string, { count: number; channel: string; last: string }>();
    for (const m of (msgsRes.data ?? []) as Array<{ conversation_id: string; created_at: string; is_private_note: boolean }>) {
      if (m.is_private_note) continue;
      const day = m.created_at.slice(0, 10);
      const channel = convChannel.get(m.conversation_id) ?? 'whatsapp';
      const key = `${day}|${channel}`;
      const cur = msgAgg.get(key) ?? { count: 0, channel, last: m.created_at };
      cur.count += 1;
      if (m.created_at > cur.last) cur.last = m.created_at;
      msgAgg.set(key, cur);
    }
    for (const [key, agg] of msgAgg) {
      const day = key.split('|')[0];
      push(day, {
        id: `conv-${key}`,
        kind: 'conversa',
        label: `Conversa via ${CHANNEL_LABEL[agg.channel] ?? agg.channel}`,
        text: `${agg.count} mensagem${agg.count !== 1 ? 's' : ''} trocada${agg.count !== 1 ? 's' : ''}`,
        at: agg.last,
        channel: agg.channel,
      });
    }

    // 2. Mudanças de estágio (IA/humano).
    for (const h of (histRes.data ?? []) as Array<{
      id: string; to_stage_id: string; from_stage_id: string | null; moved_by: string; reason: string | null; created_at: string;
    }>) {
      const day = h.created_at.slice(0, 10);
      const to = stageName.get(h.to_stage_id) ?? 'estágio';
      const from = h.from_stage_id ? stageName.get(h.from_stage_id) : null;
      const who = h.moved_by === 'ia' ? 'IA' : 'Humano';
      push(day, {
        id: `hist-${h.id}`,
        kind: 'mudanca_estagio',
        label: `Mudança de etapa · ${who}`,
        text: `${from ? `${from} → ` : ''}${to}${h.reason ? ` — ${h.reason}` : ''}`,
        at: h.created_at,
      });
    }

    // 2b. Desfechos de negócio (ganho/perdido) — mesmo quando marcados pelo
    //     botão do card (que não gera mudança de estágio).
    for (const d of dealList) {
      if (d.status === 'won' && d.won_at) {
        push(d.won_at.slice(0, 10), {
          id: `won-${d.id}`, kind: 'ganho', label: 'Negócio ganho',
          text: d.title, at: d.won_at,
        });
      } else if (d.status === 'lost' && d.lost_at) {
        push(d.lost_at.slice(0, 10), {
          id: `lost-${d.id}`, kind: 'perdido', label: 'Negócio perdido',
          text: d.lost_reason ? `${d.title} — ${d.lost_reason}` : d.title, at: d.lost_at,
        });
      }
    }

    // 3. Interações persistidas (notas por data).
    for (const it of (interRes.data ?? []) as Array<{
      id: string; interaction_date: string; channel: string | null; summary: string | null; event_type: string | null; created_at: string;
      interaction_notes: Array<{ id: string; note: string; author_id: string | null; created_at: string }> | null;
    }>) {
      const day = it.interaction_date;
      for (const n of it.interaction_notes ?? []) {
        push(day, {
          id: `note-${n.id}`,
          kind: 'nota',
          label: 'Nota',
          text: n.note,
          at: n.created_at,
          author_id: n.author_id,
        });
      }
    }

    // 4. Ações agendadas (followup/call/meeting/task): entrada "agendada" no
    //    created_at (com o prazo no texto) e "concluída" no done_at.
    for (const a of (actsRes.data ?? []) as Array<{
      id: string; deal_id: string | null; type: string; title: string | null; body: string | null;
      due_at: string | null; done: boolean; done_at: string | null; created_at: string;
    }>) {
      const label = CRM_ACTION_LABEL[a.type as CrmActionType] ?? a.type;
      const dealTitle = a.deal_id ? dealTitleById.get(a.deal_id) : null;
      const what = a.body ?? a.title ?? '';
      push(a.created_at.slice(0, 10), {
        id: `act-${a.id}`,
        kind: 'acao_agendada',
        label: `Ação agendada · ${label}`,
        text: `${what}${a.due_at ? ` — para ${fmtDue(a.due_at)}` : ''}${dealTitle ? ` (${dealTitle})` : ''}`,
        at: a.created_at,
      });
      if (a.done) {
        const at = a.done_at ?? a.created_at;
        push(at.slice(0, 10), {
          id: `actdone-${a.id}`,
          kind: 'acao_concluida',
          label: `Ação concluída · ${label}`,
          text: `${what}${dealTitle ? ` (${dealTitle})` : ''}`,
          at,
        });
      }
    }

    const sortedDays = Array.from(dayMap.keys()).sort((a, b) => (a < b ? 1 : -1));
    const built: DayGroup[] = sortedDays.map((date) => ({
      date,
      entries: (dayMap.get(date) ?? []).sort((a, b) => (a.at < b.at ? 1 : -1)),
    }));
    setGroups(built);
    setLoading(false);
  }, [contactId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Adiciona uma nota a um dia específico: acha/cria a interação daquele dia e
  // grava a nota (autor = usuário atual).
  const addNoteToDay = useCallback(
    async (date: string, text: string) => {
      const body = text.trim();
      if (!body || !contactId) return;
      const supabase = getSupabase();
      const { data: u } = await supabase.auth.getUser();
      const authorId = u?.user?.id ?? null;

      const { data: existing } = await supabase
        .from('contact_interactions')
        .select('id')
        .eq('contact_id', contactId)
        .eq('interaction_date', date)
        .eq('event_type', 'nota')
        .limit(1)
        .maybeSingle();

      let interactionId = (existing as { id: string } | null)?.id ?? null;
      if (!interactionId) {
        const { data: ins, error: insErr } = await supabase
          .from('contact_interactions')
          .insert({ contact_id: contactId, interaction_date: date, channel: 'sistema', event_type: 'nota', summary: 'Notas' })
          .select('id')
          .single();
        if (insErr) throw new Error(insErr.message);
        interactionId = (ins as { id: string }).id;
      }

      const { error: noteErr } = await supabase
        .from('interaction_notes')
        .insert({ interaction_id: interactionId, author_id: authorId, note: body });
      if (noteErr) throw new Error(noteErr.message);
      await reload();
    },
    [contactId, reload],
  );

  return { groups, loading, error, reload, addNoteToDay };
}
