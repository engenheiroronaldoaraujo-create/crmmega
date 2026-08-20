export type KnowledgeType = 'pdf' | 'doc' | 'url';
export type KnowledgeStatus = 'processing' | 'ready' | 'error';

export interface KnowledgeBase {
  id: string;
  name: string;
  type: KnowledgeType;
  source_url: string | null;
  file_path: string | null;
  file_size_bytes: number;
  status: KnowledgeStatus;
  created_at: string;
  updated_at: string;
}
