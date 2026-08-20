import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from 'react';
import { toast } from 'sonner';
import { Clock, FileText, Loader2, Mic, Paperclip, Send, Square, StickyNote, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getSupabase } from '@/lib/supabase';
import type { SendResult } from '@/hooks/useMessages';
import { TemplateRestartDialog } from './TemplateRestartDialog';

interface MessageInputProps {
  conversationId: string;
  disabled?: boolean;
  // false = contato fora da janela de 24h (Meta bloqueia texto livre).
  withinWindow?: boolean;
  // Envio OTIMISTA de texto/nota: o balão aparece na hora e a requisição roda
  // em segundo plano (dono do estado é o useMessages).
  onSendText: (text: string, isPrivate: boolean) => Promise<SendResult>;
}

const MAX_BYTES = 25 * 1024 * 1024;

export function MessageInput({ conversationId, disabled, withinWindow = true, onSendText }: MessageInputProps) {
  const [content, setContent] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [showTemplate, setShowTemplate] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [sending, setSending] = useState(false); // só para mídia (upload real bloqueia)
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Gravação de áudio (voice note) via MediaRecorder.
  const [recording, setRecording] = useState(false);
  const [recordSecs, setRecordSecs] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const discardRef = useRef(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => () => {
    // Desmontou no meio da gravação: solta o microfone.
    recorderRef.current?.stream.getTracks().forEach((t) => t.stop());
    if (timerRef.current) window.clearInterval(timerRef.current);
  }, []);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : undefined;
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      discardRef.current = false;
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        if (timerRef.current) window.clearInterval(timerRef.current);
        setRecording(false);
        setRecordSecs(0);
        if (discardRef.current || chunksRef.current.length === 0) return;
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        const voice = new File([blob], 'voice-note.webm', { type: blob.type });
        void sendVoice(voice);
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
      setRecordSecs(0);
      timerRef.current = window.setInterval(() => setRecordSecs((sec) => sec + 1), 1000);
    } catch {
      toast.error('Não foi possível acessar o microfone', {
        description: 'Verifique a permissão de microfone do navegador.',
      });
    }
  };

  const stopRecording = (send: boolean) => {
    discardRef.current = !send;
    recorderRef.current?.stop();
  };

  const sendVoice = async (voice: File) => {
    setSending(true);
    try {
      const supabase = getSupabase();
      const form = new FormData();
      form.append('conversation_id', conversationId);
      form.append('file', voice);
      form.append('voice_note', 'true');
      const { data, error } = await supabase.functions.invoke('send-operator-media', { body: form });
      if (error || !data?.ok) {
        toast.error('Falha ao enviar áudio', {
          description: data?.error ?? error?.message ?? 'Erro desconhecido',
        });
      }
    } finally {
      setSending(false);
    }
  };

  const onPickFile = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    if (f && f.size > MAX_BYTES) {
      toast.error('Arquivo excede 25MB.');
      e.target.value = '';
      return;
    }
    setFile(f);
    if (f) setIsPrivate(false); // mídia nunca é nota privada
  };

  const sendMedia = async () => {
    if (!file) return;
    const supabase = getSupabase();
    const form = new FormData();
    form.append('conversation_id', conversationId);
    form.append('file', file);
    if (content.trim()) form.append('content', content.trim());
    const { data, error } = await supabase.functions.invoke('send-operator-media', { body: form });
    if (error || !data?.ok) {
      toast.error('Falha ao enviar mídia', {
        description: data?.error ?? error?.message ?? 'Erro desconhecido',
      });
      return;
    }
    setFile(null);
    setContent('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // Texto/nota: OTIMISTA. Limpa o input na hora, o balão aparece imediatamente
  // (dentro do onSendText) e a requisição roda em segundo plano. Não bloqueia o
  // campo — o operador já pode digitar a próxima mensagem.
  const sendText = async () => {
    const text = content.trim();
    if (!text) return;
    const wasPrivate = isPrivate;
    setContent('');
    const res = await onSendText(text, wasPrivate);
    if (res.ok && res.zernioError) {
      // Balão salvo, mas o canal recusou o envio (ex.: fora da janela de 24h).
      toast.warning('Salvo, mas não entregue ao contato', { description: res.zernioError });
    }
    // Falha total: o próprio balão mostra "Não enviou · Reenviar" — sem toast.
  };

  const submit = async () => {
    if (disabled) return;
    if (file) {
      if (sending) return;
      setSending(true);
      try {
        await sendMedia();
      } finally {
        setSending(false);
      }
      return;
    }
    void sendText();
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    void submit();
  };

  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="border-t border-[rgba(59,130,246,0.08)] p-4 space-y-3 glass-surface"
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setIsPrivate((v) => !v)}
          className={
            isPrivate
              ? 'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold bg-[rgba(245,158,11,0.12)] text-[#FBBF24]'
              : 'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold text-[var(--color-text-secondary)] hover:bg-white/5'
          }
          disabled={disabled || sending || Boolean(file)}
        >
          <StickyNote className="h-3.5 w-3.5" />
          {isPrivate ? 'Nota privada' : 'Mensagem pública'}
        </button>
        {isPrivate && (
          <span className="text-[10px] text-[var(--color-text-secondary)] opacity-70">
            Visível só para operadores — não vai pro contato
          </span>
        )}
      </div>

      {!withinWindow && !isPrivate ? (
        <div className="flex flex-col gap-2 rounded-lg border border-[rgba(245,158,11,0.3)] bg-[rgba(245,158,11,0.05)] p-3">
          <div className="flex items-center gap-2 text-sm text-[#FBBF24]">
            <Clock className="h-4 w-4" />
            Fora da janela de 24h — só é possível reiniciar com um template aprovado.
          </div>
          <p className="text-[11px] leading-relaxed text-[var(--color-text-secondary)]">
            O template é entregue agora, mas a janela de 24h só reabre quando o
            contato responder. Enquanto ele não responder, o envio de mensagens
            livres continua bloqueado.
          </p>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" onClick={() => setShowTemplate(true)} disabled={disabled || sending}>
              <FileText className="h-4 w-4" />
              Reiniciar com template
            </Button>
            <span className="text-[11px] text-[var(--color-text-secondary)] opacity-70">
              Ou use “Nota privada” para um registro interno.
            </span>
          </div>
        </div>
      ) : null}

      {(withinWindow || isPrivate) && file && (
        <div className="flex items-center gap-2 rounded-lg border border-[rgba(59,130,246,0.2)] bg-white/[0.03] px-3 py-2 text-xs">
          <Paperclip className="h-3.5 w-3.5 text-[var(--accent-primary)]" />
          <span className="truncate text-[var(--color-text-primary)]">{file.name}</span>
          <span className="text-[var(--color-text-secondary)]">
            {(file.size / 1024 / 1024).toFixed(1)} MB
          </span>
          <button
            type="button"
            onClick={() => {
              setFile(null);
              if (fileInputRef.current) fileInputRef.current.value = '';
            }}
            className="ml-auto text-[var(--color-text-secondary)] hover:text-[var(--color-error)]"
            aria-label="Remover arquivo"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div className={`flex items-end gap-2 ${!withinWindow && !isPrivate ? 'hidden' : ''}`}>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          accept="image/*,audio/*,video/*,application/pdf"
          onChange={onPickFile}
          disabled={disabled || sending}
        />
        {!isPrivate && !recording && (
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled || sending}
              aria-label="Anexar arquivo"
              title="Anexar imagem, áudio, vídeo ou documento (máx 25MB)"
            >
              <Paperclip className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => void startRecording()}
              disabled={disabled || sending || Boolean(file)}
              aria-label="Gravar áudio"
              title="Gravar mensagem de voz"
            >
              <Mic className="h-4 w-4" />
            </Button>
          </>
        )}
        {recording && (
          <div className="flex flex-1 items-center gap-3 rounded-lg border border-[rgba(239,68,68,0.35)] bg-[rgba(239,68,68,0.06)] px-3 py-2">
            <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-[var(--color-error)]" />
            <span className="text-sm font-mono text-[var(--color-text-primary)]">
              {String(Math.floor(recordSecs / 60)).padStart(2, '0')}:{String(recordSecs % 60).padStart(2, '0')}
            </span>
            <span className="text-xs text-[var(--color-text-secondary)]">Gravando…</span>
            <div className="ml-auto flex items-center gap-1">
              <Button type="button" variant="ghost" size="icon" onClick={() => stopRecording(false)} aria-label="Cancelar gravação" title="Cancelar">
                <X className="h-4 w-4 text-[var(--color-error)]" />
              </Button>
              <Button type="button" size="icon" onClick={() => stopRecording(true)} aria-label="Enviar áudio" title="Parar e enviar">
                <Square className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        )}
        {!recording && (
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={handleKey}
          rows={2}
          disabled={disabled || sending}
          placeholder={
            file
              ? 'Legenda (opcional)…'
              : isPrivate
                ? 'Escreva uma nota interna…'
                : 'Digite uma mensagem…'
          }
          className={
            isPrivate
              ? 'flex-1 rounded-lg border border-[rgba(245,158,11,0.3)] bg-[rgba(245,158,11,0.04)] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:outline-none focus:border-[#FBBF24] resize-none'
              : 'flex-1 rounded-lg border border-[rgba(59,130,246,0.2)] bg-white/[0.03] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--accent-primary)] resize-none'
          }
        />
        )}
        {!recording && (
        <Button type="submit" disabled={(!content.trim() && !file) || sending || disabled} aria-label="Enviar" title="Enviar">
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          {/* No mobile some o texto pra sobrar espaço p/ a caixa de texto. */}
          <span className="hidden sm:inline">Enviar</span>
        </Button>
        )}
      </div>

      <TemplateRestartDialog
        open={showTemplate}
        onClose={() => setShowTemplate(false)}
        conversationId={conversationId}
      />
    </form>
  );
}
