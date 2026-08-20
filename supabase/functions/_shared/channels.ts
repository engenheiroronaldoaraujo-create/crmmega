// ============================================================================
// _shared/channels.ts — números WhatsApp por organização
// ----------------------------------------------------------------------------
// Cada linha de whatsapp_hub.channels é um número conectado da org:
//   provider='zernio'  → conta na API oficial via Zernio (zernio_account_id;
//                        a api_key da org vive em public.org_settings)
//   provider='uazapi'  → instância UAZAPI própria (server_url + token cifrado)
//
// Este módulo resolve org + canal a partir do que cada contexto tem em mãos:
//   webhooks UAZAPI  → webhook_secret (?secret= na URL)
//   webhooks Zernio  → zernio_account_id do evento
//   envio (IA/operador/campanha) → channel_id carimbado na conversa/campanha,
//     com fallback legado (provider + zernio_account_id) para linhas antigas.
// ============================================================================

import type { getAdminClient } from './supabase-admin.ts';
import { getCredential } from './credentials.ts';
import { ZernioError, type ZernioContext } from './zernio.ts';
import {
  type UazapiContext,
  uazapiContextFromChannel,
} from './uazapi.ts';

type Admin = ReturnType<typeof getAdminClient>;

export interface ChannelRow {
  id: string;
  org_id: string;
  provider: 'zernio' | 'uazapi';
  label: string;
  phone: string | null;
  zernio_account_id: string | null;
  uazapi_server_url: string | null;
  uazapi_token_encrypted: string | null;
  webhook_secret: string;
  assigned_member: string | null;
  is_active: boolean;
  // IA por número — refina o master switch ai_agent_config.active_whatsapp.
  ai_enabled: boolean;
  // Auto-add de leads ao funil: quando um lead entra em contato por este canal
  // pela 1ª vez, cria um deal no pipeline/stage escolhidos.
  funnel_auto_add: boolean;
  funnel_pipeline_id: string | null;
  funnel_stage_id: string | null;
}

const CHANNEL_COLUMNS =
  'id, org_id, provider, label, phone, zernio_account_id, uazapi_server_url, '
  + 'uazapi_token_encrypted, webhook_secret, assigned_member, is_active, ai_enabled, '
  + 'funnel_auto_add, funnel_pipeline_id, funnel_stage_id';

export async function getChannelById(
  admin: Admin,
  channelId: string,
): Promise<ChannelRow | null> {
  const { data, error } = await admin
    .from('channels')
    .select(CHANNEL_COLUMNS)
    .eq('id', channelId)
    .maybeSingle();
  if (error) throw error;
  return (data as ChannelRow | null) ?? null;
}

export async function getChannelByWebhookSecret(
  admin: Admin,
  secret: string,
): Promise<ChannelRow | null> {
  if (!secret) return null;
  const { data, error } = await admin
    .from('channels')
    .select(CHANNEL_COLUMNS)
    .eq('webhook_secret', secret)
    .maybeSingle();
  if (error) throw error;
  return (data as ChannelRow | null) ?? null;
}

export async function getChannelByZernioAccount(
  admin: Admin,
  zernioAccountId: string,
): Promise<ChannelRow | null> {
  if (!zernioAccountId) return null;
  const { data, error } = await admin
    .from('channels')
    .select(CHANNEL_COLUMNS)
    .eq('provider', 'zernio')
    .eq('zernio_account_id', zernioAccountId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as ChannelRow | null) ?? null;
}

// Único canal UAZAPI ativo da org — fallback para conversas legadas
// (provider='uazapi' sem channel_id carimbado).
export async function getSoleUazapiChannel(
  admin: Admin,
  orgId: string,
): Promise<ChannelRow | null> {
  const { data, error } = await admin
    .from('channels')
    .select(CHANNEL_COLUMNS)
    .eq('org_id', orgId)
    .eq('provider', 'uazapi')
    .eq('is_active', true)
    .order('created_at')
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as ChannelRow | null) ?? null;
}

export async function listActiveChannels(
  admin: Admin,
  orgId: string,
  provider?: 'zernio' | 'uazapi',
): Promise<ChannelRow[]> {
  let query = admin
    .from('channels')
    .select(CHANNEL_COLUMNS)
    .eq('org_id', orgId)
    .eq('is_active', true);
  if (provider) query = query.eq('provider', provider);
  const { data, error } = await query.order('created_at');
  if (error) throw error;
  return (data ?? []) as ChannelRow[];
}

// Contexto Zernio da ORG (api_key do cofre). O accountId default é o do canal
// zernio mais antigo ativo (fallback: credencial legada zernio_account_id).
export async function loadOrgZernioContext(
  admin: Admin,
  orgId: string,
  preferredAccountId?: string | null,
): Promise<ZernioContext> {
  const apiKey = (await getCredential(orgId, 'zernio_api_key'))?.trim();
  if (!apiKey) {
    throw new ZernioError('Zernio API Key nao configurada. Acesse /settings/credentials.', 400);
  }
  let accountId = preferredAccountId?.trim() || null;
  if (!accountId) {
    const channels = await listActiveChannels(admin, orgId, 'zernio');
    accountId = channels[0]?.zernio_account_id ?? null;
  }
  if (!accountId) {
    accountId = (await getCredential(orgId, 'zernio_account_id'))?.trim() || null;
  }
  if (!accountId) {
    throw new ZernioError('Nenhum número Zernio conectado. Acesse /settings (Canais).', 400);
  }
  const profileId = (await getCredential(orgId, 'zernio_profile_id'))?.trim() || null;
  return { apiKey, accountId, profileId };
}

export type SendContext =
  | { provider: 'zernio'; orgId: string; channel: ChannelRow | null; zernio: ZernioContext }
  | { provider: 'uazapi'; orgId: string; channel: ChannelRow; uazapi: UazapiContext };

// Resolve o contexto de ENVIO para uma conversa: usa o canal carimbado
// (channel_id); linhas legadas caem no fallback por provider/zernio_account_id.
export async function getSendContextForConversation(
  admin: Admin,
  conv: {
    org_id: string;
    channel_id?: string | null;
    provider?: string | null;
    zernio_account_id?: string | null;
  },
): Promise<SendContext> {
  let channel: ChannelRow | null = null;
  if (conv.channel_id) {
    channel = await getChannelById(admin, conv.channel_id);
  }

  const provider = channel?.provider
    ?? (conv.provider === 'uazapi' ? 'uazapi' : 'zernio');

  if (provider === 'uazapi') {
    if (!channel) {
      channel = await getSoleUazapiChannel(admin, conv.org_id);
    }
    if (!channel) {
      throw new Error('Nenhum canal UAZAPI ativo configurado para esta organização.');
    }
    return {
      provider: 'uazapi',
      orgId: conv.org_id,
      channel,
      uazapi: await uazapiContextFromChannel(channel),
    };
  }

  if (!channel && conv.zernio_account_id) {
    channel = await getChannelByZernioAccount(admin, conv.zernio_account_id);
    // Segurança: canal achado por accountId precisa ser da MESMA org.
    if (channel && channel.org_id !== conv.org_id) channel = null;
  }
  const zernio = await loadOrgZernioContext(
    admin,
    conv.org_id,
    channel?.zernio_account_id ?? conv.zernio_account_id ?? null,
  );
  return { provider: 'zernio', orgId: conv.org_id, channel, zernio };
}
