import {
  Bot,
  CircleAlert,
  Clock3,
  Pause,
  Play,
  Send,
  Settings2,
  Square,
  X
} from 'lucide-react';
import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { MAX_AGENT_INSTRUCTION_LENGTH } from '../../shared/constants';
import type { AgentChatSnapshot, AgentRunState, AgentSummary } from '../../shared/schemas';
import { agentHistory } from '../lib/agent-sync';

const STATE_LABELS: Record<AgentRunState, string> = {
  idle: 'Listo',
  queued: 'En cola',
  running: 'Ejecutando',
  paused: 'Pausado',
  completed: 'Completado',
  error: 'Error'
};
// Within this distance of the end the history keeps following new activity; further up, the reader keeps their place.
const STICK_TO_BOTTOM_PX = 48;

export interface AgentChatPanelProps {
  browserId: string;
  summary: AgentSummary | null;
  snapshot: AgentChatSnapshot | null;
  providerReady?: boolean;
  loading?: boolean;
  error?: string | null;
  onClose: () => void;
  onOpenSettings: () => void;
  onSend: (instruction: string) => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}

export function agentStateLabel(state: AgentRunState): string {
  return STATE_LABELS[state];
}

export function AgentChatPanel({
  browserId,
  summary,
  snapshot,
  providerReady = false,
  loading = false,
  error = null,
  onClose,
  onOpenSettings,
  onSend,
  onPause,
  onResume,
  onStop
}: AgentChatPanelProps) {
  const [instruction, setInstruction] = useState('');
  const historyRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const state = summary?.state ?? 'idle';
  const requiresProvider = summary?.requiresProvider ?? !providerReady;
  const canSend = !loading && !requiresProvider && instruction.trim().length > 0;
  const canPause = !loading && (state === 'running' || state === 'queued');
  const canResume = !loading && state === 'paused';
  const canStop = !loading && (state === 'queued' || state === 'running' || state === 'paused');
  const items = agentHistory(snapshot);
  const latestOutcome = snapshot?.tasks.findLast((task) => task.outcome !== null)?.outcome ?? null;
  const lastItem = items.at(-1)?.key;

  useLayoutEffect(() => {
    const history = historyRef.current;
    if (history && followRef.current) history.scrollTop = history.scrollHeight;
  }, [items.length, lastItem, error]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next = instruction.trim();
    if (!next || requiresProvider || loading) return;
    setInstruction('');
    followRef.current = true;
    onSend(next);
  };

  return (
    <aside
      aria-label={`Agente del navegador ${browserId}`}
      className="agent-chat-panel"
      data-agent-browser-id={browserId}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <header className="agent-panel-header">
        <div className="agent-panel-title">
          <Bot aria-hidden="true" size={15} />
          <strong>Agente</strong>
          <span aria-live="polite" className={`agent-state-badge is-${state}`}>{agentStateLabel(state)}</span>
        </div>
        <div className="agent-panel-header-actions">
          <button aria-label="Configurar proveedor del agente" onClick={onOpenSettings} title="Configurar proveedor" type="button"><Settings2 size={14} /></button>
          <button aria-label="Cerrar panel del agente" onClick={onClose} title="Cerrar panel (el agente sigue trabajando)" type="button"><X size={14} /></button>
        </div>
      </header>

      <div className="agent-control-row" aria-label="Controles del agente">
        {state === 'paused' ? (
          <button aria-label="Reanudar agente" disabled={!canResume} onClick={onResume} type="button"><Play size={12} /> Reanudar</button>
        ) : (
          <button aria-label="Pausar agente" disabled={!canPause} onClick={onPause} type="button"><Pause size={12} /> Pausar</button>
        )}
        <button aria-label="Detener agente y cancelar su cola" className="agent-stop-button" disabled={!canStop} onClick={onStop} type="button"><Square size={11} /> Detener</button>
        {summary && summary.queuedTaskCount > 0 ? <span className="agent-queue-count"><Clock3 size={11} /> {summary.queuedTaskCount} en cola</span> : null}
        {summary?.queuedTaskCount === 0 && latestOutcome === 'cancelled' ? <span className="agent-task-outcome is-cancelled">Cancelado</span> : null}
        {summary?.queuedTaskCount === 0 && latestOutcome === 'interrupted' ? <span className="agent-task-outcome is-interrupted">Interrumpido</span> : null}
      </div>

      <div
        aria-live="polite"
        aria-relevant="additions text"
        className="agent-history"
        onScroll={(event) => {
          const element = event.currentTarget;
          followRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < STICK_TO_BOTTOM_PX;
        }}
        ref={historyRef}
        role="log"
      >
        {loading && !snapshot ? <div className="agent-panel-loading"><span className="agent-loading-dot" /> Cargando conversación…</div> : null}

        {requiresProvider ? (
          <section className="agent-empty-state agent-provider-required">
            <Settings2 aria-hidden="true" size={25} />
            <strong>Configura un proveedor</strong>
            <p>Añade una URL OpenAI-compatible, un modelo y una clave para ejecutar el agente.</p>
            <button onClick={onOpenSettings} type="button">Abrir configuración</button>
          </section>
        ) : null}

        {!requiresProvider && !(loading && !snapshot) && items.length === 0 ? (
          <section className="agent-empty-state">
            <Bot aria-hidden="true" size={25} />
            <strong>¿Qué debe hacer este navegador?</strong>
            <p>El agente solo puede observar y controlar esta tarjeta. Puedes pausarlo o detenerlo en cualquier momento; cerrar el panel no lo detiene.</p>
          </section>
        ) : null}

        {snapshot?.conversationSummary ? (
          <details className="agent-conversation-summary">
            <summary>Resumen de la conversación anterior</summary>
            <p>{snapshot.conversationSummary}</p>
          </details>
        ) : null}

        {items.map((item) => item.kind === 'message' ? (
          <article className={`agent-message is-${item.message.role}`} key={item.key}>
            <span>{item.message.role === 'user' ? 'Tú' : 'Agente'}</span>
            <p>{item.message.content}</p>
          </article>
        ) : (
          <div className={`agent-timeline-event is-${item.event.level}`} key={item.key}>
            {item.event.level === 'info' ? <span className="agent-event-dot" /> : <CircleAlert aria-hidden="true" size={12} />}
            <span>{item.event.summary}</span>
          </div>
        ))}

        {error ? <div className="agent-inline-error" role="alert"><CircleAlert aria-hidden="true" size={13} /><span>{error}</span></div> : null}
      </div>

      <form className="agent-composer" onSubmit={submit}>
        <label className="sr-only" htmlFor={`agent-instruction-${browserId}`}>Instrucción para el agente</label>
        <textarea
          aria-describedby={`agent-composer-help-${browserId}`}
          disabled={requiresProvider}
          id={`agent-instruction-${browserId}`}
          maxLength={MAX_AGENT_INSTRUCTION_LENGTH}
          onChange={(event) => setInstruction(event.target.value)}
          onKeyDown={(event) => {
            // Enter while an input method is composing confirms the composition, not the instruction.
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={requiresProvider ? 'Configura un proveedor para comenzar' : 'Describe qué debe hacer…'}
          rows={3}
          value={instruction}
        />
        <div className="agent-composer-footer">
          <span id={`agent-composer-help-${browserId}`}>
            {state === 'running' || state === 'queued' ? 'Se añadirá a la cola de esta tarjeta' : 'Enter para enviar · Shift+Enter para nueva línea'}
          </span>
          <button aria-label="Enviar instrucción" disabled={!canSend} type="submit"><Send size={13} /></button>
        </div>
      </form>
    </aside>
  );
}
