// ============================================================================
// _shared/funnel.ts — auto-add de leads ao funil por canal
// ----------------------------------------------------------------------------
// Quando um lead entra em contato pela 1ª vez por um canal com
// funnel_auto_add ligado, cria um deal no pipeline/stage escolhidos.
// Idempotente por (contact_id, pipeline_id): não duplica se o contato já tem
// deal naquele funil. Best-effort — falha aqui nunca quebra o inbound.
// ============================================================================

import type { getAdminClient } from './supabase-admin.ts';
import type { ChannelRow } from './channels.ts';

type Admin = ReturnType<typeof getAdminClient>;

export async function maybeAddLeadToFunnel(
  admin: Admin,
  orgId: string,
  contactId: string,
  channel: ChannelRow | null,
  leadTitle: string | null,
  originChannel: 'whatsapp' | 'instagram' = 'whatsapp',
): Promise<void> {
  if (!channel?.funnel_auto_add) return;
  const pipelineId = channel.funnel_pipeline_id;
  const stageId = channel.funnel_stage_id;
  if (!pipelineId || !stageId) return;

  try {
    // Dedup: contato já tem deal neste funil? (sem UNIQUE no banco)
    const { data: existing } = await admin
      .from('deals')
      .select('id')
      .eq('org_id', orgId)
      .eq('contact_id', contactId)
      .eq('pipeline_id', pipelineId)
      .limit(1)
      .maybeSingle();
    if (existing) return;

    // Status nasce coerente com a etapa (ganho/perdido contam de imediato).
    const { data: stage } = await admin
      .from('stages')
      .select('is_won, is_lost')
      .eq('id', stageId)
      .maybeSingle();
    const st = (stage ?? {}) as { is_won?: boolean; is_lost?: boolean };
    const nowIso = new Date().toISOString();

    const payload: Record<string, unknown> = {
      org_id: orgId,
      contact_id: contactId,
      pipeline_id: pipelineId,
      stage_id: stageId,
      title: leadTitle?.trim() || 'Novo lead',
      lead_type: 'Lead',
      status: st.is_won ? 'won' : st.is_lost ? 'lost' : 'open',
      origin_channel: originChannel,
      first_contact_at: nowIso,
    };
    if (st.is_won) payload.won_at = nowIso;
    if (st.is_lost) payload.lost_at = nowIso;
    // Herda o operador do canal como dono do deal, se houver.
    if (channel.assigned_member) payload.owner_id = channel.assigned_member;

    const { error } = await admin.from('deals').insert(payload);
    if (error) {
      console.log(JSON.stringify({ event: 'funnel_autoadd_insert_error', message: error.message }));
    }
  } catch (err) {
    console.log(JSON.stringify({ event: 'funnel_autoadd_error', error: String(err) }));
  }
}
