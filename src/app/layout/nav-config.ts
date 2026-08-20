import {
  LayoutDashboard,
  Inbox,
  Megaphone,
  Users,
  Bot,
  Settings,
  KanbanSquare,
  Zap,
  Building2,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  // Itens adminOnly só aparecem para role 'admin'. Operadores não veem
  // Credenciais (escrita admin-only — antes a rota existia mas sem link,
  // deixando Configurações/Equipe/Conta inalcançáveis pela UI).
  adminOnly?: boolean;
  // Itens superAdminOnly só aparecem para o super admin da instância
  // (JWT is_super_admin). Ex.: console de Organizações (/admin).
  superAdminOnly?: boolean;
}

// Single source of truth for both the Sidebar and the router. Adding a new
// app section is a one-liner here.
// Base de Conhecimento, Follow-ups e Horário de atendimento viraram abas dentro
// de /ai-agent. Credenciais virou aba dentro de Configurações. Templates virou
// aba dentro de /campaigns (Módulo 1).
export const NAV_ITEMS: NavItem[] = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, adminOnly: true },
  { to: '/inbox', label: 'Inbox', icon: Inbox },
  { to: '/funil', label: 'Funil', icon: KanbanSquare, adminOnly: true },
  { to: '/contacts', label: 'Contatos', icon: Users },
  { to: '/campaigns', label: 'Campanhas', icon: Megaphone },
  { to: '/automations', label: 'Automações', icon: Zap, adminOnly: true },
  { to: '/ai-agent', label: 'Agente de IA', icon: Bot, adminOnly: true },
  { to: '/settings/profile', label: 'Configurações', icon: Settings },
  { to: '/admin', label: 'Organizações', icon: Building2, superAdminOnly: true },
];
