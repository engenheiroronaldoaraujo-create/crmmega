// Minimal TypeScript shape of the whatsapp_hub tables this module touches.
// Not a full Supabase codegen — we only model the columns we actively read
// or write so the editor catches typos without dragging in the whole schema.

export interface Tag {
  id: string;
  name: string;
  color: string;
  created_at: string;
  updated_at: string;
}

export interface Contact {
  id: string;
  // Nullable desde o canal Instagram: contatos de DM não têm telefone —
  // são identificados por instagram_id.
  phone: string | null;
  name: string | null;
  email: string | null;
  instagram_id?: string | null;
  source?: string | null;
  // Foto de perfil do lead (via UAZAPI). Leads Zernio não têm — fallback iniciais.
  profile_pic_url?: string | null;
  // Data do primeiro registro do contato (Módulo 5) — coluna da lista.
  first_seen_at?: string | null;
  custom_fields: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// Membro da instância (whatsapp_hub.app_users). Perfil exibível + org.
export interface AppUser {
  id: string;
  user_id: string;
  role: 'admin' | 'operator';
  org_id: string | null;
  display_name: string | null;
  avatar_url: string | null;
  is_super_admin: boolean;
  is_online: boolean;
  accepted_at: string | null;
  invited_at: string | null;
  created_at: string;
}

export interface ContactTag {
  contact_id: string;
  tag_id: string;
  created_at: string;
}

export interface ContactWithTags extends Contact {
  tags: Tag[];
  // Origem derivada do deal mais recente (Módulo 5): 'organico' | 'pago' | 'manual'.
  traffic_type?: string | null;
}
