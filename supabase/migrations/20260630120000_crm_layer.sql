-- ============================================================================
-- Módulo CRM · Funil (negócios), Entrega (projetos) e Educação (turmas)
-- ============================================================================
-- Adiciona a camada de CRM sobre o hub de WhatsApp. Tudo vive no mesmo schema
-- `whatsapp_hub` e ancora no `contacts` existente: o MESMO contato atravessa
-- comercial → entrega → educação, com uma timeline e um inbox só.
--
-- Convenções herdadas do hub:
--   · schema único `whatsapp_hub` (público reservado para extensions).
--   · trigger `whatsapp_hub.set_updated_at()` para updated_at.
--   · RLS: SELECT aberto a authenticated; escrita gated por
--     `whatsapp_hub.current_user_role()` em ('admin','operator').
--   · grants já cobertos por ALTER DEFAULT PRIVILEGES (migration init); repetidos
--     aqui de forma idempotente por segurança.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

-- ----------------------------------------------------------------------------
-- Enums (prefixo crm_ para não colidir com os enums do hub)
-- ----------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE whatsapp_hub.crm_pipeline_kind AS ENUM ('comercial','projeto','educacao');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE whatsapp_hub.crm_deal_status AS ENUM ('open','won','lost');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE whatsapp_hub.crm_project_status AS ENUM ('active','on_hold','done','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE whatsapp_hub.crm_task_status AS ENUM ('todo','doing','done');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE whatsapp_hub.crm_enrollment_status AS ENUM ('active','completed','dropped','paused');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE whatsapp_hub.crm_activity_type AS ENUM ('task','note','followup','call','meeting','stage_change');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ----------------------------------------------------------------------------
-- pipelines + stages (funis customizáveis: comercial / projeto / turma)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_hub.pipelines (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  kind       whatsapp_hub.crm_pipeline_kind NOT NULL DEFAULT 'comercial',
  position   INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS whatsapp_hub.stages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id UUID NOT NULL REFERENCES whatsapp_hub.pipelines(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  position    INT NOT NULL DEFAULT 0,
  is_won      BOOLEAN NOT NULL DEFAULT false,
  is_lost     BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stages_pipeline ON whatsapp_hub.stages(pipeline_id, position);

-- ----------------------------------------------------------------------------
-- COMERCIAL: deals (ancorado em contacts)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_hub.deals (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id     UUID NOT NULL REFERENCES whatsapp_hub.contacts(id) ON DELETE CASCADE,
  pipeline_id    UUID REFERENCES whatsapp_hub.pipelines(id) ON DELETE SET NULL,
  stage_id       UUID REFERENCES whatsapp_hub.stages(id) ON DELETE SET NULL,
  title          TEXT NOT NULL,
  value          NUMERIC(14,2) DEFAULT 0,
  currency       TEXT NOT NULL DEFAULT 'BRL',
  status         whatsapp_hub.crm_deal_status NOT NULL DEFAULT 'open',
  expected_close DATE,
  won_at         TIMESTAMPTZ,
  lost_at        TIMESTAMPTZ,
  owner_id       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_deals_contact ON whatsapp_hub.deals(contact_id);
CREATE INDEX IF NOT EXISTS idx_deals_stage   ON whatsapp_hub.deals(stage_id);
CREATE TRIGGER trg_deals_updated_at BEFORE UPDATE ON whatsapp_hub.deals
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub.set_updated_at();

-- ----------------------------------------------------------------------------
-- ENTREGA: projects + project_tasks
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_hub.projects (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id    UUID NOT NULL REFERENCES whatsapp_hub.contacts(id) ON DELETE CASCADE,
  deal_id       UUID REFERENCES whatsapp_hub.deals(id) ON DELETE SET NULL,
  pipeline_id   UUID REFERENCES whatsapp_hub.pipelines(id) ON DELETE SET NULL,
  stage_id      UUID REFERENCES whatsapp_hub.stages(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  status        whatsapp_hub.crm_project_status NOT NULL DEFAULT 'active',
  client_status TEXT,
  start_date    DATE,
  due_date      DATE,
  owner_id      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_projects_contact ON whatsapp_hub.projects(contact_id);
CREATE TRIGGER trg_projects_updated_at BEFORE UPDATE ON whatsapp_hub.projects
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub.set_updated_at();

CREATE TABLE IF NOT EXISTS whatsapp_hub.project_tasks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES whatsapp_hub.projects(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  status      whatsapp_hub.crm_task_status NOT NULL DEFAULT 'todo',
  assignee_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  due_date    DATE,
  position    INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_project_tasks_project ON whatsapp_hub.project_tasks(project_id, position);

-- ----------------------------------------------------------------------------
-- EDUCAÇÃO: courses + classes (turmas) + enrollments
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_hub.courses (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS whatsapp_hub.classes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id  UUID NOT NULL REFERENCES whatsapp_hub.courses(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  start_date DATE,
  end_date   DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_classes_course ON whatsapp_hub.classes(course_id);

CREATE TABLE IF NOT EXISTS whatsapp_hub.enrollments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id  UUID NOT NULL REFERENCES whatsapp_hub.contacts(id) ON DELETE CASCADE,
  class_id    UUID NOT NULL REFERENCES whatsapp_hub.classes(id) ON DELETE CASCADE,
  status      whatsapp_hub.crm_enrollment_status NOT NULL DEFAULT 'active',
  progress    INT NOT NULL DEFAULT 0,
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (contact_id, class_id)
);
CREATE INDEX IF NOT EXISTS idx_enrollments_contact ON whatsapp_hub.enrollments(contact_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_class   ON whatsapp_hub.enrollments(class_id);

-- ----------------------------------------------------------------------------
-- crm_activities: tarefas / notas / follow-ups do funil (não confundir com
-- `messages`, que é a conversa de WhatsApp).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_hub.crm_activities (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES whatsapp_hub.contacts(id) ON DELETE CASCADE,
  deal_id    UUID REFERENCES whatsapp_hub.deals(id) ON DELETE CASCADE,
  project_id UUID REFERENCES whatsapp_hub.projects(id) ON DELETE CASCADE,
  type       whatsapp_hub.crm_activity_type NOT NULL DEFAULT 'task',
  title      TEXT,
  body       TEXT,
  due_at     TIMESTAMPTZ,
  done       BOOLEAN NOT NULL DEFAULT false,
  owner_id   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_activities_contact ON whatsapp_hub.crm_activities(contact_id, created_at);
CREATE INDEX IF NOT EXISTS idx_crm_activities_due     ON whatsapp_hub.crm_activities(due_at) WHERE done = false;

-- ----------------------------------------------------------------------------
-- crm_ai_actions: log auditável do que a IA fez (transparência)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_hub.crm_ai_actions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id  UUID REFERENCES whatsapp_hub.contacts(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL,
  description TEXT,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_ai_actions_contact ON whatsapp_hub.crm_ai_actions(contact_id, created_at);

-- ----------------------------------------------------------------------------
-- RPC: promover um negócio ganho a projeto (lifecycle comercial → entrega).
-- Chamado explicitamente pela UI; idempotente por deal.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION whatsapp_hub.crm_promote_deal_to_project(p_deal_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, public, pg_temp
AS $$
DECLARE
  v_project_id UUID;
  v_contact_id UUID;
  v_title      TEXT;
  v_proj_pipe  UUID;
  v_proj_stage UUID;
BEGIN
  SELECT id INTO v_project_id FROM whatsapp_hub.projects WHERE deal_id = p_deal_id LIMIT 1;
  IF v_project_id IS NOT NULL THEN
    RETURN v_project_id;  -- já promovido
  END IF;

  SELECT contact_id, title INTO v_contact_id, v_title
    FROM whatsapp_hub.deals WHERE id = p_deal_id;
  IF v_contact_id IS NULL THEN
    RAISE EXCEPTION 'Deal % não encontrado', p_deal_id;
  END IF;

  SELECT id INTO v_proj_pipe FROM whatsapp_hub.pipelines
    WHERE kind = 'projeto' ORDER BY position LIMIT 1;
  SELECT id INTO v_proj_stage FROM whatsapp_hub.stages
    WHERE pipeline_id = v_proj_pipe ORDER BY position LIMIT 1;

  INSERT INTO whatsapp_hub.projects (contact_id, deal_id, pipeline_id, stage_id, name, status)
  VALUES (v_contact_id, p_deal_id, v_proj_pipe, v_proj_stage, v_title, 'active')
  RETURNING id INTO v_project_id;

  RETURN v_project_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.crm_promote_deal_to_project(UUID) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION whatsapp_hub.crm_promote_deal_to_project(UUID) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- RLS — SELECT aberto a authenticated; escrita gated a admin/operator
-- ----------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'pipelines','stages','deals','projects','project_tasks',
    'courses','classes','enrollments','crm_activities','crm_ai_actions'
  ]
  LOOP
    EXECUTE format('ALTER TABLE whatsapp_hub.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON whatsapp_hub.%I FOR SELECT TO authenticated USING (true)',
      t || '_select', t);
    EXECUTE format(
      'CREATE POLICY %I ON whatsapp_hub.%I FOR ALL TO authenticated '
      || 'USING (whatsapp_hub.current_user_role() IN (''admin'',''operator'')) '
      || 'WITH CHECK (whatsapp_hub.current_user_role() IN (''admin'',''operator''))',
      t || '_write', t);
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- Grants (idempotente; default privileges já cobrem, reforçado aqui)
-- ----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON
  whatsapp_hub.pipelines, whatsapp_hub.stages, whatsapp_hub.deals,
  whatsapp_hub.projects, whatsapp_hub.project_tasks, whatsapp_hub.courses,
  whatsapp_hub.classes, whatsapp_hub.enrollments, whatsapp_hub.crm_activities,
  whatsapp_hub.crm_ai_actions
TO authenticated;

-- ----------------------------------------------------------------------------
-- Realtime (inbox/funil ao vivo)
-- ----------------------------------------------------------------------------
ALTER TABLE whatsapp_hub.deals          REPLICA IDENTITY FULL;
ALTER TABLE whatsapp_hub.project_tasks  REPLICA IDENTITY FULL;
ALTER TABLE whatsapp_hub.crm_activities REPLICA IDENTITY FULL;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE whatsapp_hub.deals;
    ALTER PUBLICATION supabase_realtime ADD TABLE whatsapp_hub.project_tasks;
    ALTER PUBLICATION supabase_realtime ADD TABLE whatsapp_hub.crm_activities;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ----------------------------------------------------------------------------
-- Seed: funis padrão (comercial + entrega) + curso/turma exemplo.
-- Out-of-the-box: instância nova já abre com funil utilizável.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  pid_com  UUID;
  pid_proj UUID;
  cid      UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM whatsapp_hub.pipelines) THEN
    INSERT INTO whatsapp_hub.pipelines (name, kind, position)
      VALUES ('Comercial', 'comercial', 0) RETURNING id INTO pid_com;
    INSERT INTO whatsapp_hub.stages (pipeline_id, name, position, is_won, is_lost) VALUES
      (pid_com, 'Novo lead',   0, false, false),
      (pid_com, 'Qualificado', 1, false, false),
      (pid_com, 'Proposta',    2, false, false),
      (pid_com, 'Negociação',  3, false, false),
      (pid_com, 'Ganho',       4, true,  false),
      (pid_com, 'Perdido',     5, false, true);

    INSERT INTO whatsapp_hub.pipelines (name, kind, position)
      VALUES ('Entrega de Projeto', 'projeto', 1) RETURNING id INTO pid_proj;
    INSERT INTO whatsapp_hub.stages (pipeline_id, name, position, is_won, is_lost) VALUES
      (pid_proj, 'Briefing',           0, false, false),
      (pid_proj, 'Em desenvolvimento', 1, false, false),
      (pid_proj, 'Revisão',            2, false, false),
      (pid_proj, 'Entregue',           3, true,  false);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM whatsapp_hub.courses) THEN
    INSERT INTO whatsapp_hub.courses (name, description)
      VALUES ('Formação em IA Aplicada', 'Curso base') RETURNING id INTO cid;
    INSERT INTO whatsapp_hub.classes (course_id, name, start_date)
      VALUES (cid, 'Turma 2026.2', '2026-08-01');
  END IF;
END $$;
