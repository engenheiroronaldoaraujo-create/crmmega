// ----------------------------------------------------------------------------
// Tipos da camada CRM (schema whatsapp_hub) — funil, entrega e educação.
// O CRM ancora no `contacts` existente: a mesma pessoa atravessa as 3 fases.
// ----------------------------------------------------------------------------

export type PipelineKind = 'comercial' | 'projeto' | 'educacao';
export type DealStatus = 'open' | 'won' | 'lost';
export type ProjectStatus = 'active' | 'on_hold' | 'done' | 'cancelled';
export type TaskStatus = 'todo' | 'doing' | 'done';
export type EnrollmentStatus = 'active' | 'completed' | 'dropped' | 'paused';

export type LeadType = 'Lead' | 'Cliente';
export type Temperature = 'Frio' | 'Morno' | 'Quente';

// Cores dos badges de temperatura (frio = azul/cinza, morno = amarelo, quente = laranja/vermelho).
export const TEMPERATURE_STYLE: Record<Temperature, { label: string; className: string; dot: string }> = {
  Frio: { label: 'Frio', className: 'bg-[rgba(96,165,250,0.14)] text-[#60A5FA]', dot: 'bg-[#60A5FA]' },
  Morno: { label: 'Morno', className: 'bg-[rgba(245,158,11,0.14)] text-[#FBBF24]', dot: 'bg-[#FBBF24]' },
  Quente: { label: 'Quente', className: 'bg-[rgba(239,68,68,0.14)] text-[#F87171]', dot: 'bg-[#F87171]' },
};

export interface Pipeline {
  id: string;
  name: string;
  kind: PipelineKind;
  position: number;
  is_default: boolean;
  created_at: string;
}

export interface Stage {
  id: string;
  pipeline_id: string;
  name: string;
  position: number;
  is_won: boolean;
  is_lost: boolean;
  color: string | null;
  // Probabilidade de fechamento (0..100) — usada no forecast do dashboard (M3).
  probability: number;
  // Critério que diz à IA o que caracteriza este estágio (M8). Sem critério, a
  // IA não move para cá.
  ai_criteria: string | null;
  created_at: string;
}

// Tipo de produto: texto livre — além dos tipos padrão abaixo, o usuário pode
// criar classes personalizadas (ex.: 'imovel').
export type ProductType = string;

export const PRODUCT_TYPE_LABELS: Record<string, string> = {
  curso: 'Curso',
  mentoria: 'Mentoria',
  consultoria: 'Consultoria',
  ebook: 'Ebook',
  app: 'App',
  ia: 'IA',
  fisico: 'Físico',
};

// Label exibível de um tipo (padrão ou personalizado — capitaliza o valor cru).
export function productTypeLabel(type: string | null | undefined): string {
  if (!type) return '—';
  return PRODUCT_TYPE_LABELS[type] ?? type.charAt(0).toUpperCase() + type.slice(1);
}

export interface Product {
  id: string;
  name: string;
  product_type: ProductType;
  // Estoque/quantidade — opcional para qualquer tipo.
  quantity: number | null;
  description: string | null;
}

// Produto associado a um deal, com valor/quantidade da compra (linha de
// deal_products). Preenchido na venda; adição manual fica com value null.
export interface DealProduct {
  id: string; // product_id
  name: string;
  value: number | null;
  quantity: number;
}

export interface Tag {
  id: string;
  name: string;
  color: string;
}

// Contato resumido embutido nas queries (PostgREST embedding via FK).
// email/custom_fields são opcionais: o board embute para os filtros do funil
// (e-mail, empresa); listas mais antigas seguem só com id/name/phone.
export interface ContactLite {
  id: string;
  name: string | null;
  phone: string;
  email?: string | null;
  custom_fields?: Record<string, unknown> | null;
}

// Contato completo carregado no drawer do card do funil.
export interface ContactFull {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  source: string | null;
  custom_fields: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export const CONTACT_SOURCE_LABEL: Record<string, string> = {
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  import: 'Importação (Excel)',
  manual: 'Cadastro manual',
};

// ---- Origem do lead (rastreio UTM do deal) ----
// traffic_type e origin_channel são derivados server-side pela trigger
// _derive_deal_traffic a partir dos utm_*. Aqui só damos rótulo/cor de exibição.
export const TRAFFIC_TYPE_LABEL: Record<string, string> = {
  organico: 'Orgânico',
  pago: 'Pago',
  manual: 'Manual',
};

export const TRAFFIC_TYPE_STYLE: Record<string, string> = {
  organico: 'bg-[rgba(16,185,129,0.14)] text-[#10B981]',
  pago: 'bg-[rgba(96,165,250,0.14)] text-[#60A5FA]',
  manual: 'bg-white/5 text-[var(--color-text-secondary)]',
};

export const ORIGIN_CHANNEL_LABEL: Record<string, string> = {
  google: 'Google',
  google_ads: 'Google Ads',
  instagram: 'Instagram',
  instagram_ads: 'Instagram Ads',
  facebook: 'Facebook',
  facebook_ads: 'Facebook Ads',
  meta_ads: 'Meta Ads',
  tiktok: 'TikTok',
  tiktok_ads: 'TikTok Ads',
  linkedin: 'LinkedIn',
  linkedin_ads: 'LinkedIn Ads',
  youtube: 'YouTube',
  ads: 'Anúncios',
  outro: 'Outro',
};

// Destaque (badge principal): agrupa a plataforma. Anúncios pagos da Meta
// (ig/fb/an/msg) aparecem todos como "Meta Ads"; a rede específica (Instagram/
// Facebook) fica como detalhe secundário no card.
const PAID_PLATFORM_LABEL: Record<string, string> = {
  instagram_ads: 'Meta Ads',
  facebook_ads: 'Meta Ads',
  meta_ads: 'Meta Ads',
  google_ads: 'Google Ads',
  tiktok_ads: 'TikTok Ads',
  linkedin_ads: 'LinkedIn Ads',
  youtube: 'YouTube Ads',
  ads: 'Anúncios',
};

// Rede/canal específico (detalhe secundário): "Instagram", "Facebook"…
const CHANNEL_NAME: Record<string, string> = {
  instagram_ads: 'Instagram',
  facebook_ads: 'Facebook',
  meta_ads: 'Meta',
  google_ads: 'Google',
  tiktok_ads: 'TikTok',
  linkedin_ads: 'LinkedIn',
  youtube: 'YouTube',
  google: 'Google',
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
  linkedin: 'LinkedIn',
  outro: 'Outro',
};

export interface DealOrigin {
  highlight: string;       // badge em destaque: "Meta Ads" | "Google Ads" | "Orgânico"
  traffic: string | null;  // 'organico' | 'pago' | 'manual' — define a cor do badge
  channel: string | null;  // rede específica p/ detalhe no card: "Instagram" | "Facebook"
  campaign: string | null;
  content: string | null;
}

// Deriva a origem exibível de um deal a partir dos parâmetros de UTM. Retorna
// null quando não há nenhum rastreio (lead manual / entrada direta).
//
// O destaque é de alto nível: pago da Meta → "Meta Ads" (não separa IG/FB no
// badge), orgânico → "Orgânico". O canal (Instagram/Facebook/…) vem como
// detalhe secundário.
export function getDealOrigin(deal: Pick<Deal,
  'utm_source' | 'utm_medium' | 'utm_campaign' | 'utm_content' | 'utm_term' | 'traffic_type' | 'origin_channel'
>): DealOrigin | null {
  const hasUtm = Boolean(
    deal.utm_source || deal.utm_medium || deal.utm_campaign ||
    deal.utm_content || deal.utm_term || deal.origin_channel,
  );
  if (!hasUtm) return null;
  const oc = deal.origin_channel;
  const traffic = deal.traffic_type;
  const channel = oc ? CHANNEL_NAME[oc] ?? ORIGIN_CHANNEL_LABEL[oc] ?? oc : deal.utm_source;

  let highlight: string;
  if (traffic === 'pago') {
    highlight = (oc && PAID_PLATFORM_LABEL[oc]) || 'Anúncios';
  } else if (traffic === 'organico') {
    highlight = 'Orgânico';
  } else {
    highlight = channel ?? 'Manual';
  }

  return {
    highlight,
    traffic,
    channel: channel ?? null,
    campaign: deal.utm_campaign,
    content: deal.utm_content,
  };
}

// ---- Ações agendadas / próxima ação (linhas de crm_activities) ----
// Uma "ação agendada" = crm_activity com due_at preenchido e done=false,
// ancorada num deal (contact_id denormalizado). Tipos de ação abaixo (note e
// stage_change NÃO são ações agendáveis).
export type CrmActionType = 'followup' | 'call' | 'meeting' | 'task';

export const CRM_ACTION_LABEL: Record<CrmActionType, string> = {
  followup: 'Retornar',
  call: 'Ligar',
  meeting: 'Reunião',
  task: 'Tarefa',
};

export const CRM_ACTION_TYPES: CrmActionType[] = ['followup', 'call', 'meeting', 'task'];

export interface CrmActivity {
  id: string;
  deal_id: string | null;
  contact_id: string | null;
  type: string; // CrmActionType | 'note' | 'stage_change'
  title: string | null;
  body: string | null;
  due_at: string | null;
  done: boolean;
  done_at: string | null;
  owner_id: string | null;
  created_at: string;
}

// Classificação de prazo de uma ação pendente → tom de cor compartilhado entre
// o componente ProximaAcao e o badge do card do funil.
export type DueTone = 'overdue' | 'today' | 'future';

export function dueTone(dueAt: string | null): DueTone {
  if (!dueAt) return 'future';
  const due = new Date(dueAt);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfTomorrow = startOfToday + 24 * 60 * 60 * 1000;
  const t = due.getTime();
  if (t < startOfToday) return 'overdue';
  if (t < startOfTomorrow) return 'today';
  return 'future';
}

// Classes Tailwind (badge/pílula) por tom de prazo.
export const DUE_TONE_STYLE: Record<DueTone, string> = {
  overdue: 'bg-[rgba(239,68,68,0.14)] text-[var(--color-error)]',
  today: 'bg-[rgba(245,158,11,0.14)] text-[#FBBF24]',
  future: 'bg-[rgba(59,130,246,0.14)] text-[var(--accent-secondary)]',
};

// ---- Campos customizáveis (definições + valores por deal) ----
export type CustomFieldType = 'text' | 'number' | 'date' | 'select' | 'boolean';

export interface CustomField {
  id: string;
  label: string;
  field_type: CustomFieldType;
  options: string[] | null;
  required: boolean;
  position: number;
  created_at: string;
}

export interface CustomFieldValue {
  id: string;
  custom_field_id: string;
  deal_id: string;
  value: string | null;
  updated_at: string;
}

export const CUSTOM_FIELD_TYPE_LABEL: Record<CustomFieldType, string> = {
  text: 'Texto',
  number: 'Número',
  date: 'Data',
  select: 'Seleção',
  boolean: 'Sim/Não',
};

export interface Deal {
  id: string;
  contact_id: string;
  pipeline_id: string | null;
  stage_id: string | null;
  title: string;
  value: number | null;
  currency: string;
  status: DealStatus;
  expected_close: string | null;
  won_at: string | null;
  lost_at: string | null;
  lost_reason: string | null;
  owner_id: string | null;
  lead_type: LeadType;
  temperature: Temperature;
  last_purchase_at: string | null;
  // Atendimento (Módulo 3): carimbados por trigger a partir das mensagens.
  first_contact_at: string | null;
  first_response_at: string | null;
  // Rastreio de origem (Módulo 4): utm_* + classificação derivada.
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  traffic_type: string | null;   // 'organico' | 'pago' | 'manual'
  origin_channel: string | null;
  // Arquivado: fora do board, visível na visão "Arquivados" (restaurável).
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  contact?: ContactLite | null;
  // Tags embutidas no board (para os chips no card). PostgREST: deal_tags(tag(*)).
  tags?: Tag[];
  // Produtos comprados embutidos no board (subtítulo do card minimizado).
  // PostgREST: deal_products(product(id, name)).
  products?: { id: string; name: string }[];
}

export interface Project {
  id: string;
  contact_id: string;
  deal_id: string | null;
  pipeline_id: string | null;
  stage_id: string | null;
  name: string;
  status: ProjectStatus;
  client_status: string | null;
  start_date: string | null;
  due_date: string | null;
  owner_id: string | null;
  created_at: string;
  updated_at: string;
  contact?: ContactLite | null;
}

export interface Course {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
}

export interface Class {
  id: string;
  course_id: string;
  name: string;
  start_date: string | null;
  end_date: string | null;
  created_at: string;
}

export interface Enrollment {
  id: string;
  contact_id: string;
  class_id: string;
  status: EnrollmentStatus;
  progress: number;
  enrolled_at: string;
  contact?: ContactLite | null;
}

export const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  active: 'Ativo',
  on_hold: 'Pausado',
  done: 'Concluído',
  cancelled: 'Cancelado',
};

export const ENROLLMENT_STATUS_LABEL: Record<EnrollmentStatus, string> = {
  active: 'Ativo',
  completed: 'Concluído',
  dropped: 'Desistiu',
  paused: 'Pausado',
};
