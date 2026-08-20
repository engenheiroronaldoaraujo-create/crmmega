import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { getSupabase } from '@/lib/supabase';
import { useAppUser } from '@/app/providers/AppUserProvider';

type DayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

interface DaySlot {
  enabled: boolean;
  start: string;
  end: string;
}

type BusinessHours = Record<DayKey, DaySlot>;

const DAY_ORDER: { key: DayKey; label: string }[] = [
  { key: 'mon', label: 'Segunda' },
  { key: 'tue', label: 'Terça' },
  { key: 'wed', label: 'Quarta' },
  { key: 'thu', label: 'Quinta' },
  { key: 'fri', label: 'Sexta' },
  { key: 'sat', label: 'Sábado' },
  { key: 'sun', label: 'Domingo' },
];

const DEFAULT_HOURS: BusinessHours = {
  mon: { enabled: true, start: '09:00', end: '18:00' },
  tue: { enabled: true, start: '09:00', end: '18:00' },
  wed: { enabled: true, start: '09:00', end: '18:00' },
  thu: { enabled: true, start: '09:00', end: '18:00' },
  fri: { enabled: true, start: '09:00', end: '18:00' },
  sat: { enabled: false, start: '09:00', end: '13:00' },
  sun: { enabled: false, start: '09:00', end: '13:00' },
};

function mergeHours(stored: unknown): BusinessHours {
  if (!stored || typeof stored !== 'object') return DEFAULT_HOURS;
  const source = stored as Partial<BusinessHours>;
  const merged = { ...DEFAULT_HOURS };
  for (const { key } of DAY_ORDER) {
    const slot = source[key];
    if (slot && typeof slot === 'object') {
      merged[key] = {
        enabled: Boolean((slot as DaySlot).enabled),
        start: (slot as DaySlot).start || DEFAULT_HOURS[key].start,
        end: (slot as DaySlot).end || DEFAULT_HOURS[key].end,
      };
    }
  }
  return merged;
}

export function BusinessHoursSettings() {
  const { userId } = useAppUser();
  const [hours, setHours] = useState<BusinessHours>(DEFAULT_HOURS);
  const [offHoursMsg, setOffHoursMsg] = useState(
    'Olá! Nosso atendimento humano está fora do horário. Responderemos assim que possível.',
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!userId) return;
    const supabase = getSupabase();
    supabase
      .from('app_settings')
      .select('business_hours, out_of_hours_message')
      .eq('id', 1)
      .maybeSingle()
      .then(({ data }) => {
        if (!data) return;
        setHours(mergeHours(data.business_hours));
        if (data.out_of_hours_message) {
          setOffHoursMsg(data.out_of_hours_message);
        }
      });
  }, [userId]);

  const updateDay = (key: DayKey, patch: Partial<DaySlot>) => {
    setHours((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!userId) return;
    setSaving(true);
    const supabase = getSupabase();
    const { error } = await supabase
      .from('app_settings')
      .update({
        business_hours: hours,
        out_of_hours_message: offHoursMsg || null,
      })
      .eq('id', 1);
    setSaving(false);
    if (error) {
      toast.error('Falha ao salvar', { description: error.message });
      return;
    }
    toast.success('Horários salvos.');
  };

  return (
    <Card>
      <form onSubmit={handleSubmit} className="space-y-6">
        <header className="space-y-1">
          <h2 className="text-xl font-bold text-display">Horário de atendimento</h2>
          <p className="text-sm text-[var(--color-text-secondary)]">
            Define quando os operadores humanos estão disponíveis. Fora desses
            horários, o agente de IA envia a mensagem de fallback abaixo.
          </p>
        </header>

        <div className="space-y-2">
          {DAY_ORDER.map(({ key, label }) => (
            <div
              key={key}
              className="grid grid-cols-[auto_100px_1fr_1fr] items-center gap-3 p-3 rounded-lg border border-[rgba(59,130,246,0.1)] bg-white/[0.02]"
            >
              <input
                type="checkbox"
                checked={hours[key].enabled}
                onChange={(e) => updateDay(key, { enabled: e.target.checked })}
                disabled={saving}
                className="accent-[var(--accent-primary)] h-4 w-4"
              />
              <span className="text-sm font-medium text-[var(--color-text-primary)]">
                {label}
              </span>
              <Input
                type="time"
                value={hours[key].start}
                onChange={(e) => updateDay(key, { start: e.target.value })}
                disabled={saving || !hours[key].enabled}
              />
              <Input
                type="time"
                value={hours[key].end}
                onChange={(e) => updateDay(key, { end: e.target.value })}
                disabled={saving || !hours[key].enabled}
              />
            </div>
          ))}
        </div>

        <div className="space-y-2">
          <Label htmlFor="off_msg">Mensagem fora do horário</Label>
          <textarea
            id="off_msg"
            value={offHoursMsg}
            onChange={(e) => setOffHoursMsg(e.target.value)}
            rows={3}
            disabled={saving}
            className="w-full rounded-lg border border-[rgba(59,130,246,0.2)] bg-white/[0.03] px-4 py-3 text-sm text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--accent-primary)] focus:bg-white/[0.06]"
          />
        </div>

        <div className="flex justify-end">
          <Button type="submit" disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Salvando...
              </>
            ) : (
              <>Salvar alterações</>
            )}
          </Button>
        </div>
      </form>
    </Card>
  );
}
