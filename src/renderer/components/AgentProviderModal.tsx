import { Check, CircleAlert, Info, KeyRound, LoaderCircle, Server, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { AgentProviderInput, AgentProviderPublic } from '../../shared/schemas';

export interface AgentProviderResult {
  ok: boolean;
  /** After a successful save, something the person must read before the dialog closes (the key is kept for this session only). */
  message?: string;
}

export interface AgentProviderModalProps {
  isOpen: boolean;
  provider: AgentProviderPublic | null;
  onClose: () => void;
  onSave: (input: AgentProviderInput) => Promise<AgentProviderResult>;
  onTest: (input: AgentProviderInput) => Promise<AgentProviderResult>;
}

type Feedback = { tone: 'success' | 'warning' | 'error'; message: string };

const REMEMBER_KEY_HINT = 'Se cifra con el llavero de macOS. Al guardar, macOS puede pedir la contraseña de tu Mac: la recibe macOS, no OmniBrowser. Elige «Permitir siempre».';
const SESSION_KEY_HINT = 'La clave se usa solo hasta que cierres OmniBrowser: no se escribe en el disco ni en el llavero, y macOS no pedirá ninguna contraseña. La URL y el modelo sí se recuerdan.';

function originOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value.trim()).origin;
  } catch {
    return null;
  }
}

export function AgentProviderModal({ isOpen, provider, onClose, onSave, onTest }: AgentProviderModalProps) {
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [rememberKey, setRememberKey] = useState(true);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  // A save that succeeded with an explanation waits until the person has read it.
  const [savedWithNotice, setSavedWithNotice] = useState(false);
  const noticeShownRef = useRef(false);
  const firstInputRef = useRef<HTMLInputElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  const rememberHintId = useId();
  const feedbackId = useId();

  useEffect(() => {
    if (!isOpen) {
      noticeShownRef.current = false;
      return;
    }
    // Saving updates the provider while its explanation is on screen; the dialog keeps showing it.
    if (noticeShownRef.current) return;
    setBaseUrl(provider?.baseUrl ?? 'https://api.openai.com/v1');
    setModel(provider?.model ?? '');
    // The stored key is deliberately never copied back into renderer state.
    setApiKey('');
    setRememberKey(provider?.keyStorage !== 'session');
    setFeedback(null);
    setSavedWithNotice(false);
    requestAnimationFrame(() => firstInputRef.current?.focus());
  }, [isOpen, provider?.baseUrl, provider?.model, provider?.keyStorage]);

  useEffect(() => {
    if (!isOpen) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  // The saved key only ever goes to the endpoint it was saved for; main enforces the same rule.
  const keepsStoredKey = provider?.hasApiKey === true && originOf(baseUrl) !== null && originOf(baseUrl) === originOf(provider.baseUrl);
  const sessionKey = provider?.keyStorage === 'session';
  const input = (): AgentProviderInput => {
    const trimmedKey = apiKey.trim();
    return {
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      ...(trimmedKey ? { apiKey: trimmedKey } : {})
    };
  };
  const valid = baseUrl.trim().length > 0 && model.trim().length > 0 && (keepsStoredKey || apiKey.trim().length > 0);
  const edit = (update: () => void) => {
    update();
    setFeedback(null);
    setSavedWithNotice(false);
  };

  const test = async () => {
    if (!valid || testing || saving) return;
    setTesting(true);
    setFeedback(null);
    const result = await onTest(input());
    setTesting(false);
    if (result.message) setFeedback({ tone: result.ok ? 'success' : 'error', message: result.message });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (savedWithNotice) {
      onClose();
      return;
    }
    if (!valid || saving || testing) return;
    setSaving(true);
    setFeedback(null);
    const result = await onSave({ ...input(), rememberKey });
    setSaving(false);
    if (result.ok && !result.message) {
      onClose();
    } else if (result.ok && result.message) {
      noticeShownRef.current = true;
      setApiKey('');
      setSavedWithNotice(true);
      setFeedback({ tone: 'warning', message: result.message });
      requestAnimationFrame(() => doneRef.current?.focus());
    } else if (result.message) {
      setFeedback({ tone: 'error', message: result.message });
    }
  };

  const feedbackIcon = feedback?.tone === 'success' ? <Check size={13} /> : feedback?.tone === 'warning' ? <Info size={13} /> : <CircleAlert size={13} />;

  return (
    <div className="modal-backdrop native-occluder" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }} role="presentation">
      <section aria-labelledby="agent-provider-title" aria-modal="true" className="modal-dialog agent-provider-dialog" role="dialog">
        <header className="agent-provider-heading">
          <div><Server aria-hidden="true" size={16} /><h2 className="modal-title" id="agent-provider-title">Proveedor del agente</h2></div>
          <button aria-label="Cerrar configuración del proveedor" onClick={onClose} type="button"><X size={15} /></button>
        </header>
        <p className="modal-description">Configura un endpoint OpenAI-compatible con salida estructurada. La clave se queda en el proceso principal y nunca se muestra de nuevo.</p>
        <form onSubmit={submit}>
          <label className="agent-provider-field">
            <span>URL base</span>
            <input autoComplete="url" className="modal-input" onChange={(event) => edit(() => setBaseUrl(event.target.value))} placeholder="https://api.example.com/v1" ref={firstInputRef} type="url" value={baseUrl} />
          </label>
          <label className="agent-provider-field">
            <span>Modelo</span>
            <input autoComplete="off" className="modal-input" onChange={(event) => edit(() => setModel(event.target.value))} placeholder="gpt-4.1-mini" value={model} />
          </label>
          <label className="agent-provider-field">
            <span>Clave API</span>
            <div className="agent-api-key-input"><KeyRound aria-hidden="true" size={14} /><input aria-label="Clave API" autoComplete="new-password" onChange={(event) => edit(() => setApiKey(event.target.value))} placeholder={keepsStoredKey ? (sessionKey ? 'Dejar en blanco para conservar la clave de esta sesión' : 'Dejar en blanco para conservar la clave guardada') : 'Introduce una clave API'} type="password" value={apiKey} /></div>
            {keepsStoredKey ? <small><Check size={11} /> {sessionKey ? 'Hay una clave activa solo en esta sesión. No se envió al renderer.' : 'Hay una clave cifrada guardada. No se envió al renderer.'}</small> : null}
            {provider?.hasApiKey && !keepsStoredKey ? <small className="is-required">La clave guardada solo se usa con su proveedor; introdúcela para este endpoint.</small> : null}
          </label>
          <div className="agent-provider-remember">
            <label>
              <input aria-describedby={rememberHintId} checked={rememberKey} onChange={(event) => edit(() => setRememberKey(event.target.checked))} type="checkbox" />
              <span>Recordar la clave en este Mac</span>
            </label>
            <small id={rememberHintId}>{rememberKey ? REMEMBER_KEY_HINT : SESSION_KEY_HINT}</small>
          </div>
          {feedback ? (
            <div className={`agent-provider-test-result is-${feedback.tone}`} id={feedbackId} role={feedback.tone === 'error' ? 'alert' : 'status'}>
              {feedbackIcon}<span>{feedback.message}</span>
            </div>
          ) : null}
          <div className="modal-actions">
            {savedWithNotice ? (
              <button aria-describedby={feedbackId} className="modal-button primary" onClick={onClose} ref={doneRef} type="button">Listo</button>
            ) : (
              <>
                <button className="modal-button" disabled={!valid || testing || saving} onClick={() => void test()} type="button">{testing ? <LoaderCircle className="spin" size={13} /> : null}Probar conexión</button>
                <button className="modal-button primary" disabled={!valid || testing || saving} type="submit">{saving ? <LoaderCircle className="spin" size={13} /> : null}{rememberKey ? 'Guardar' : 'Usar en esta sesión'}</button>
              </>
            )}
          </div>
        </form>
      </section>
    </div>
  );
}
