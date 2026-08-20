import { useMemo, useState, type ChangeEvent } from 'react';
import { toast } from 'sonner';
import * as XLSX from 'xlsx';
import { CheckCircle2, FileUp, Loader2, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { getSupabase } from '@/lib/supabase';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { normalizePhone } from '@/lib/phone';

type FieldMapping =
  | { kind: 'skip' }
  | { kind: 'phone' }
  | { kind: 'name' }
  | { kind: 'email' }
  | { kind: 'custom'; name: string };

interface ImportContactsDialogProps {
  open: boolean;
  onClose: () => void;
  onDone?: () => void;
}

interface ImportReport {
  totalRows: number;
  imported: number;
  invalid: number;
  duplicates: number;
  errors: { row: number; reason: string }[];
}

const CHUNK_SIZE = 500;

function readFile(file: File): Promise<string[][]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = new Uint8Array(reader.result as ArrayBuffer);
        const wb = XLSX.read(data, { type: 'array' });
        const firstSheet = wb.SheetNames[0];
        const ws = wb.Sheets[firstSheet];
        const rows = XLSX.utils.sheet_to_json<string[]>(ws, {
          header: 1,
          raw: false,
          defval: '',
        });
        resolve(rows.map((r) => r.map((c) => (c == null ? '' : String(c).trim()))));
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

function guessInitialMapping(headers: string[]): FieldMapping[] {
  return headers.map((h) => {
    const low = h.toLowerCase();
    if (/(phone|telefone|celular|whats)/.test(low)) return { kind: 'phone' };
    if (/(name|nome)/.test(low)) return { kind: 'name' };
    if (/(email|e-mail|mail)/.test(low)) return { kind: 'email' };
    return { kind: 'skip' };
  });
}

export function ImportContactsDialog({
  open,
  onClose,
  onDone,
}: ImportContactsDialogProps) {
  const { userId } = useAppUser();
  const [step, setStep] = useState<'upload' | 'map' | 'running' | 'done'>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<string[][]>([]);
  const [hasHeader, setHasHeader] = useState(true);
  const [mapping, setMapping] = useState<FieldMapping[]>([]);
  const [progress, setProgress] = useState(0);
  const [report, setReport] = useState<ImportReport | null>(null);

  const reset = () => {
    setStep('upload');
    setFile(null);
    setRows([]);
    setMapping([]);
    setProgress(0);
    setReport(null);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const parsed = await readFile(f);
      if (parsed.length === 0) {
        toast.error('Arquivo vazio.');
        return;
      }
      setFile(f);
      setRows(parsed);
      setMapping(guessInitialMapping(parsed[0] ?? []));
      setStep('map');
    } catch (err) {
      toast.error('Falha ao ler arquivo', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const headers = useMemo(() => {
    if (rows.length === 0) return [];
    return hasHeader ? rows[0] : rows[0].map((_, i) => `Coluna ${i + 1}`);
  }, [rows, hasHeader]);

  const previewBody = useMemo(() => {
    return hasHeader ? rows.slice(1, 11) : rows.slice(0, 10);
  }, [rows, hasHeader]);

  const phoneColumn = mapping.findIndex((m) => m.kind === 'phone');

  const runImport = async () => {
    if (!userId) return;
    if (phoneColumn === -1) {
      toast.error('Mapeie ao menos uma coluna para "Telefone".');
      return;
    }

    setStep('running');
    setProgress(0);

    const supabase = getSupabase();
    const data = hasHeader ? rows.slice(1) : rows;
    const total = data.length;

    const nameIdx = mapping.findIndex((m) => m.kind === 'name');
    const emailIdx = mapping.findIndex((m) => m.kind === 'email');
    const customCols = mapping
      .map((m, i) => (m.kind === 'custom' ? { i, name: m.name } : null))
      .filter((x): x is { i: number; name: string } => !!x);

    const seen = new Set<string>();
    const pending: Array<{
      phone: string;
      name: string | null;
      email: string | null;
      custom_fields: Record<string, string>;
    }> = [];
    const errors: { row: number; reason: string }[] = [];
    let duplicates = 0;
    let invalid = 0;

    for (let i = 0; i < data.length; i++) {
      const r = data[i];
      const rawPhone = r[phoneColumn] ?? '';
      const parsed = normalizePhone(rawPhone);
      if (!parsed.ok) {
        invalid++;
        errors.push({ row: i + (hasHeader ? 2 : 1), reason: parsed.error });
        continue;
      }
      if (seen.has(parsed.e164)) {
        duplicates++;
        continue;
      }
      seen.add(parsed.e164);

      const custom: Record<string, string> = {};
      for (const c of customCols) {
        const v = r[c.i];
        if (v) custom[c.name] = v;
      }

      pending.push({
        phone: parsed.e164,
        name: nameIdx >= 0 ? (r[nameIdx] || null) : null,
        email: emailIdx >= 0 ? (r[emailIdx] || null) : null,
        custom_fields: custom,
      });
    }

    // Chunked upsert — onConflict uses the UNIQUE(phone) constraint.
    let imported = 0;
    for (let i = 0; i < pending.length; i += CHUNK_SIZE) {
      const chunk = pending.slice(i, i + CHUNK_SIZE);
      const { error } = await supabase
        .from('contacts')
        .upsert(chunk, { onConflict: 'phone' });
      if (error) {
        errors.push({ row: -1, reason: `batch ${i / CHUNK_SIZE + 1}: ${error.message}` });
      } else {
        imported += chunk.length;
      }
      setProgress(Math.round(((i + chunk.length) / Math.max(pending.length, 1)) * 100));
    }

    setReport({
      totalRows: total,
      imported,
      invalid,
      duplicates,
      errors: errors.slice(0, 20),
    });
    setStep('done');
    if (errors.length === 0) {
      toast.success(`${imported} contatos importados.`);
    } else {
      toast.warning(`${imported} importados, ${invalid + duplicates + errors.length} ignorados.`);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title="Importar contatos"
      description="Aceita CSV e XLSX. Telefones são normalizados para E.164 (+55…); duplicados por telefone são mesclados."
      widthClass="max-w-4xl"
    >
      {step === 'upload' && (
        <label
          htmlFor="contacts_file"
          className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-[rgba(59,130,246,0.25)] bg-white/[0.02] p-10 cursor-pointer hover:border-[rgba(59,130,246,0.5)]"
        >
          <FileUp className="h-8 w-8 text-[var(--accent-primary)]" />
          <div className="text-center">
            <div className="font-semibold">Clique para selecionar um arquivo</div>
            <div className="text-sm text-[var(--color-text-secondary)]">
              .csv, .xlsx ou .xls
            </div>
          </div>
          <input
            id="contacts_file"
            type="file"
            accept=".csv,.xlsx,.xls"
            onChange={handleFile}
            className="sr-only"
          />
        </label>
      )}

      {step === 'map' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm text-[var(--color-text-secondary)]">
              <span className="font-mono text-[var(--color-text-primary)]">
                {file?.name}
              </span>
              {' '}·{' '}
              {rows.length} linhas
            </div>
            <label className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
              <input
                type="checkbox"
                checked={hasHeader}
                onChange={(e) => {
                  setHasHeader(e.target.checked);
                  setMapping(guessInitialMapping(e.target.checked ? rows[0] ?? [] : []));
                }}
                className="accent-[var(--accent-primary)]"
              />
              Primeira linha é cabeçalho
            </label>
          </div>

          <div className="rounded-lg border border-[rgba(59,130,246,0.1)] overflow-auto max-h-[340px]">
            <table className="w-full text-xs">
              <thead className="bg-white/[0.03] sticky top-0">
                <tr>
                  {headers.map((h, i) => (
                    <th key={i} className="p-2 text-left border-b border-[rgba(59,130,246,0.08)] min-w-[140px]">
                      <div className="font-semibold text-[var(--color-text-primary)] mb-1 truncate">
                        {h || `Coluna ${i + 1}`}
                      </div>
                      <select
                        value={
                          mapping[i]?.kind === 'custom'
                            ? `custom:${(mapping[i] as { kind: 'custom'; name: string }).name}`
                            : mapping[i]?.kind ?? 'skip'
                        }
                        onChange={(e) => {
                          const v = e.target.value;
                          setMapping((prev) => {
                            const next = [...prev];
                            if (v === 'skip') next[i] = { kind: 'skip' };
                            else if (v === 'phone') next[i] = { kind: 'phone' };
                            else if (v === 'name') next[i] = { kind: 'name' };
                            else if (v === 'email') next[i] = { kind: 'email' };
                            else if (v === 'custom-new') {
                              const name = prompt('Nome do campo personalizado:');
                              if (name?.trim()) next[i] = { kind: 'custom', name: name.trim() };
                            }
                            return next;
                          });
                        }}
                        className="w-full rounded border border-[rgba(59,130,246,0.15)] bg-black/20 px-2 py-1 text-xs text-[var(--color-text-primary)]"
                      >
                        <option value="skip">— ignorar —</option>
                        <option value="phone">📞 telefone</option>
                        <option value="name">👤 nome</option>
                        <option value="email">📧 e-mail</option>
                        {mapping[i]?.kind === 'custom' && (
                          <option value={`custom:${(mapping[i] as { kind: 'custom'; name: string }).name}`}>
                            ⚙ custom: {(mapping[i] as { kind: 'custom'; name: string }).name}
                          </option>
                        )}
                        <option value="custom-new">⚙ custom (novo…)</option>
                      </select>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {previewBody.map((r, i) => (
                  <tr key={i} className="border-b border-[rgba(59,130,246,0.04)]">
                    {headers.map((_, j) => (
                      <td key={j} className="p-2 text-[var(--color-text-secondary)] truncate max-w-[200px]">
                        {r[j] ?? ''}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex justify-between gap-3">
            <Button variant="ghost" onClick={() => setStep('upload')}>
              Voltar
            </Button>
            <Button onClick={runImport} disabled={phoneColumn === -1}>
              Importar{' '}
              {hasHeader ? rows.length - 1 : rows.length} linhas
            </Button>
          </div>
          {phoneColumn === -1 && (
            <p className="text-xs text-[var(--color-error)]">
              Pelo menos uma coluna precisa ser mapeada como "Telefone".
            </p>
          )}
        </div>
      )}

      {step === 'running' && (
        <div className="py-10 flex flex-col items-center gap-4">
          <Loader2 className="h-8 w-8 animate-spin text-[var(--accent-primary)]" />
          <div className="text-sm text-[var(--color-text-primary)]">
            Importando... {progress}%
          </div>
          <div className="w-full max-w-md h-2 rounded-full bg-white/5 overflow-hidden">
            <div
              className="h-full bg-[var(--accent-primary)] transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {step === 'done' && report && (
        <div className="space-y-4">
          <div className="flex items-center gap-3 rounded-lg border border-[rgba(16,185,129,0.3)] bg-[rgba(16,185,129,0.05)] p-4">
            <CheckCircle2 className="h-6 w-6 text-[var(--color-success)]" />
            <div className="text-sm">
              <div className="font-semibold">Importação concluída</div>
              <div className="text-[var(--color-text-secondary)]">
                {report.imported} contatos importados de {report.totalRows} linhas
                {report.invalid > 0 && ` · ${report.invalid} inválidos`}
                {report.duplicates > 0 && ` · ${report.duplicates} duplicados`}
              </div>
            </div>
          </div>

          {report.errors.length > 0 && (
            <div className="rounded-lg border border-[rgba(239,68,68,0.25)] bg-[rgba(239,68,68,0.04)] p-4 space-y-2">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <AlertTriangle className="h-4 w-4 text-[var(--color-error)]" />
                Amostras de linhas ignoradas
              </div>
              <ul className="text-xs font-mono space-y-1 text-[var(--color-text-secondary)] max-h-[200px] overflow-auto">
                {report.errors.map((e, i) => (
                  <li key={i}>
                    {e.row > 0 ? `linha ${e.row}: ` : ''}
                    {e.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                reset();
              }}
            >
              Nova importação
            </Button>
            <Button
              onClick={() => {
                onDone?.();
                handleClose();
              }}
            >
              Fechar
            </Button>
          </div>
        </div>
      )}

    </Dialog>
  );
}
