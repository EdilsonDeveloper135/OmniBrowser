import { randomUUID } from 'node:crypto';
import type {
  AgentChatSnapshot,
  AgentProviderInput,
  AgentProviderPublic,
  AgentProviderTestResult,
  AgentSummary,
  AgentTimelineEvent
} from '../../shared/schemas';
import {
  MAX_ACTIVE_AGENTS,
  MAX_AGENT_INSTRUCTION_LENGTH,
  MAX_AGENT_PROGRESS_SUMMARY_LENGTH,
  MAX_AGENT_QUEUED_TASKS,
  MAX_AGENT_TIMELINE_SUMMARY_LENGTH
} from '../../shared/constants';
import { OmniUserError } from '../../shared/errors';
import type { AutomationTarget, AutomationTargetRevocationReason } from '../browser/browser-runtime';
import {
  AgentStore,
  type AgentBrowserDescriptor,
  type StoredAgentRecord,
  type StoredAgentTask,
  type StoredAgentTimelineEvent
} from './agent-store';
import {
  normalizeProviderBaseUrl,
  ProviderStore,
  validateAgentProviderInput
} from './provider-store';
import { AgentWorker, AgentWorkerError, type AgentWorkerEvent, type AgentWorkerOptions } from './agent-worker';
import { ScopedCdpGateway, type ScopedCdpGatewayOptions } from './scoped-cdp-gateway';

const MAX_PUBLIC_RESULT_LENGTH = 32 * 1024;
// Reasoning models behind OpenAI-compatible routers can take tens of seconds for one answer; Browser Use itself waits
// 75 seconds per step.
const PROVIDER_TEST_TIMEOUT_MS = 60_000;
// Browser Use's ChatOpenAI caps every agent step at this many output tokens, reasoning included. The check uses the
// same budget, so a model that passes it can also answer inside the agent.
const PROVIDER_TEST_MAX_TOKENS = 4096;
const MAX_PROVIDER_ERROR_DETAIL = 200;
// macOS asks for the Mac's password the first time each build reads the keychain, and a denial lasts until OmniBrowser
// restarts. The key can always be typed again for the current session.
const PROVIDER_KEY_UNAVAILABLE_MESSAGE = 'macOS no permitió usar la clave guardada en el llavero. Escríbela de nuevo en «Proveedor del agente» para usarla en esta sesión, o reinicia OmniBrowser y elige «Permitir siempre» cuando macOS la pida.';
// Earlier chat turns handed to a new task, so that a follow-up instruction such as "now open the second result" has
// the context of the previous one. Each worker otherwise starts from a blank Browser Use agent.
const CONTEXT_MESSAGE_COUNT = 8;
const CONTEXT_MESSAGE_LENGTH = 1_500;
const PROGRESS_ACTION_COUNT = 20;

// Worker error codes come from the sidecar and from AgentWorker; the text shown in the chat is always Spanish.
const WORKER_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  'runtime-unavailable': 'El runtime de agentes no está disponible en esta instalación.',
  'runtime-not-built': 'El runtime de agentes no está construido en esta copia de desarrollo. Ejecuta npm run agent:build y vuelve a intentarlo.',
  'runtime-start-failed': 'El agente no pudo iniciarse en este browser.',
  'runtime-exited': 'El runtime de agentes terminó antes de inicializarse.',
  'ready-timeout': 'El runtime de agentes no respondió a tiempo.',
  'identity-mismatch': 'El runtime respondió con una identidad de sesión inválida.',
  'agent-run-failed': 'El agente falló mientras controlaba este browser.',
  'task-incomplete': 'El agente se detuvo antes de completar la tarea.',
  'test-runtime': 'El runtime de agentes está desactivado en esta compilación de prueba.'
};
const PROTOCOL_ERROR_MESSAGE = 'El runtime de agentes rechazó la solicitud: su protocolo no es compatible con esta versión de OmniBrowser.';
const ACTION_LABELS: Readonly<Record<string, string>> = {
  click: 'clic',
  done: 'finalizar',
  dropdown_options: 'leer opciones',
  extract: 'extraer contenido',
  find_elements: 'buscar elementos',
  find_text: 'buscar texto',
  go_back: 'atrás',
  input: 'escribir',
  navigate_current: 'navegar',
  scroll: 'desplazar',
  search: 'buscar en la web',
  search_page: 'buscar en la página',
  select_dropdown: 'elegir opción',
  send_keys: 'teclas',
  wait: 'esperar'
};

interface AgentGateway {
  readonly runtimeEpoch: number;
  start(): Promise<string>;
  stop(): Promise<void>;
}

interface ManagedWorker {
  start(config: Parameters<AgentWorker['start']>[0]): Promise<void>;
  pause(runId: string): void;
  resume(runId: string): void;
  stop(runId: string): void;
  dispose(): void;
  terminate(): void;
}

interface ActiveAgentRun {
  readonly browserId: string;
  readonly agentId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly runtimeEpoch: number;
  readonly gateway: AgentGateway;
  readonly worker: ManagedWorker;
  lastWorkerSequence: number;
  terminal: boolean;
}

export interface AgentManagerOptions {
  store: AgentStore;
  providerStore: ProviderStore;
  listBrowserDescriptors: () => readonly AgentBrowserDescriptor[];
  getBrowserDescriptor: (browserId: string) => AgentBrowserDescriptor | null;
  acquireTarget: (browserId: string) => AutomationTarget;
  emitState: (summary: AgentSummary) => void;
  emitEvent: (event: AgentTimelineEvent) => void;
  onNotice?: (level: 'info' | 'warning' | 'error', message: string) => void;
  createGateway?: (options: ScopedCdpGatewayOptions) => AgentGateway;
  createWorker?: (options: AgentWorkerOptions) => ManagedWorker;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  createId?: () => string;
  maxActiveAgents?: number;
}

function truncate(value: string, maximum = MAX_PUBLIC_RESULT_LENGTH): string {
  const normalized = value.replace(/\0/g, '').trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 14)}\n[TRUNCATED]`;
}

/** Keeps the end of a context block: the most recent turns and actions matter most to the next worker. */
function truncateHead(value: string, maximum: number): string {
  return value.length <= maximum ? value : `[…]\n${value.slice(-(maximum - 4))}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The system keychain refused, is unavailable, or no longer decrypts the stored key. */
function isProviderKeyError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'ProviderEncryptionUnavailableError' || error.name === 'ProviderDecryptionError');
}

function workerErrorMessage(code: string | undefined, diagnostic?: string): string {
  const base = code === undefined
    ? 'El agente terminó con un error.'
    : WORKER_ERROR_MESSAGES[code] ?? (/^(?:invalid|unsupported|message|protocol|run)-/.test(code) ? PROTOCOL_ERROR_MESSAGE : 'El agente terminó con un error.');
  // The sidecar reports "<ExceptionType>: <redacted message>". Only the exception type is shown: it names the failing
  // layer (an authentication or rate-limit error from the provider, a timeout) without echoing page content.
  const exceptionType = diagnostic?.match(/^([A-Za-z_][\w.]{0,80}):/)?.[1];
  return exceptionType && code === 'agent-run-failed' ? `${base.slice(0, -1)} (${exceptionType}).` : base;
}

function actionSummary(event: Extract<AgentWorkerEvent, { type: 'action' }>): string {
  const names = (event.actions ?? []).filter((name) => /^[A-Za-z0-9_.:-]{1,64}$/.test(name));
  const step = event.step === undefined ? 'Paso' : `Paso ${event.step}`;
  return names.length > 0 ? `${step}: ${names.map((name) => ACTION_LABELS[name] ?? name).join(', ')}` : `${step} del agente`;
}

async function providerErrorDetail(response: Response, apiKey: string): Promise<string> {
  let text: string;
  try {
    text = (await response.text()).slice(0, 4096);
  } catch {
    return '';
  }
  let detail = text;
  try {
    const body: unknown = JSON.parse(text);
    const candidate = isRecord(body) && isRecord(body.error) ? body.error.message : isRecord(body) ? body.message : null;
    detail = typeof candidate === 'string' ? candidate : '';
  } catch {
    // Some gateways answer errors with plain text or HTML; only a short single line is kept.
    if (/<[a-z!]/i.test(detail)) detail = '';
  }
  // eslint-disable-next-line no-control-regex -- control characters from a remote body are replaced, never displayed.
  const cleaned = detail.split(apiKey).join('[REDACTED]').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length <= MAX_PROVIDER_ERROR_DETAIL ? cleaned : `${cleaned.slice(0, MAX_PROVIDER_ERROR_DETAIL - 1)}…`;
}

/**
 * Owns the one-browser/one-agent boundary. Renderer callers can name only a browserId; target handles,
 * CDP capabilities, workers and credentials never leave the main process.
 */
export class AgentManager {
  readonly #store: AgentStore;
  readonly #providerStore: ProviderStore;
  readonly #listBrowserDescriptors: AgentManagerOptions['listBrowserDescriptors'];
  readonly #getBrowserDescriptor: AgentManagerOptions['getBrowserDescriptor'];
  readonly #acquireTarget: AgentManagerOptions['acquireTarget'];
  readonly #emitState: AgentManagerOptions['emitState'];
  readonly #emitEvent: AgentManagerOptions['emitEvent'];
  readonly #onNotice: NonNullable<AgentManagerOptions['onNotice']>;
  readonly #createGateway: NonNullable<AgentManagerOptions['createGateway']>;
  readonly #createWorker: NonNullable<AgentManagerOptions['createWorker']>;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #maxActiveAgents: number;
  readonly #records = new Map<string, StoredAgentRecord>();
  readonly #targets = new Map<string, AutomationTarget>();
  readonly #active = new Map<string, ActiveAgentRun>();
  readonly #scheduled = new Set<string>();
  readonly #browserOperations = new Map<string, Promise<unknown>>();
  #providerConfigured = false;
  #initializing: Promise<void> | null = null;
  #initialized = false;
  #unavailableReason: string | null = null;
  #shuttingDown = false;
  #disposed = false;

  constructor(options: AgentManagerOptions) {
    this.#store = options.store;
    this.#providerStore = options.providerStore;
    this.#listBrowserDescriptors = options.listBrowserDescriptors;
    this.#getBrowserDescriptor = options.getBrowserDescriptor;
    this.#acquireTarget = options.acquireTarget;
    this.#emitState = options.emitState;
    this.#emitEvent = options.emitEvent;
    this.#onNotice = options.onNotice ?? (() => undefined);
    this.#createGateway = options.createGateway ?? ((gatewayOptions) => new ScopedCdpGateway(gatewayOptions));
    this.#createWorker = options.createWorker ?? ((workerOptions) => new AgentWorker(workerOptions));
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
    this.#maxActiveAgents = Math.max(1, Math.floor(options.maxActiveAgents ?? MAX_ACTIVE_AGENTS));
  }

  /** Never rejects for storage problems: agents become unavailable, but the browser workspace still starts. */
  initialize(): Promise<void> {
    if (this.#initialized) return Promise.resolve();
    this.#assertActive();
    this.#initializing ??= this.#load().finally(() => { this.#initializing = null; });
    return this.#initializing;
  }

  async #load(): Promise<void> {
    try {
      const diagnostics = await this.#store.initialize();
      for (const diagnostic of diagnostics) this.#onNotice('warning', diagnostic.message);
      const provider = await this.#providerStore.initialize();
      if (provider.warning) this.#onNotice('warning', provider.warning);
      // The stored key is decrypted when a task or a test needs it, not at launch: reading the keychain here would make
      // macOS ask for the Mac's password on every start, even when no agent is used.
      this.#providerConfigured = provider.provider?.hasApiKey === true;
      const records = await this.#store.reconcile(this.#listBrowserDescriptors());
      for (const record of records) {
        const interrupted = this.#interruptRestoredRun(record);
        const saved = interrupted ? await this.#store.save(record) : record;
        this.#records.set(saved.browserId, saved);
      }
    } catch (error) {
      this.#records.clear();
      this.#providerConfigured = false;
      this.#unavailableReason = `Los agentes no están disponibles: ${truncate(errorMessage(error), 300)}`;
      console.error('[omnibrowser] No se pudieron cargar los agentes:', error);
      this.#onNotice('error', this.#unavailableReason);
    }
    this.#initialized = true;
    this.#pump();
  }

  get available(): boolean {
    return this.#initialized && this.#unavailableReason === null;
  }

  async list(): Promise<AgentSummary[]> {
    await this.initialize();
    if (this.#unavailableReason) return [];
    return [...this.#records.values()]
      .filter((record) => this.#getBrowserDescriptor(record.browserId) !== null)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((record) => this.#summary(record));
  }

  async get(browserId: string): Promise<AgentChatSnapshot> {
    await this.#ready();
    const record = await this.#serialize(browserId, () => this.#ensureRecord(browserId));
    return this.#snapshot(record);
  }

  /** Whether switching this browser's profile would discard a conversation, so the confirmation can say so. */
  hasConversation(browserId: string): boolean {
    const record = this.#records.get(browserId);
    return Boolean(record && (record.messages.length > 0 || record.tasks.length > 0));
  }

  async send(browserId: string, instruction: string): Promise<AgentChatSnapshot> {
    await this.#ready();
    if (!this.#providerConfigured) {
      throw new OmniUserError('conflict', 'Configura y prueba un proveedor de IA antes de enviar una instrucción.');
    }
    const snapshot = await this.#serialize(browserId, async () => {
      const record = await this.#ensureRecord(browserId);
      if (record.queuedTaskIds.length >= MAX_AGENT_QUEUED_TASKS) {
        throw new OmniUserError('conflict', `La cola de este browser ya tiene ${MAX_AGENT_QUEUED_TASKS} instrucciones. Espera a que avance o detén el agente.`);
      }
      const timestamp = this.#timestamp();
      const taskId = this.#createId();
      const task: StoredAgentTask = {
        id: taskId,
        instruction: truncate(instruction, MAX_AGENT_INSTRUCTION_LENGTH),
        state: 'queued',
        createdAt: timestamp,
        updatedAt: timestamp,
        startedAt: null,
        completedAt: null,
        outcome: null
      };
      const busy = this.#active.has(browserId) || record.activeTaskId !== null || record.queuedTaskIds.length > 0;
      record.tasks.push(task);
      record.queuedTaskIds.push(taskId);
      record.messages.push({ id: this.#createId(), role: 'user', content: task.instruction, createdAt: timestamp, taskId });
      if (!this.#active.has(browserId) && record.state !== 'paused') record.state = 'queued';
      const event = this.#appendEvent(record, {
        taskId,
        runId: null,
        kind: 'state',
        level: 'info',
        summary: record.state === 'paused'
          ? 'Instrucción añadida a la cola; el agente sigue en pausa hasta que lo reanudes.'
          : busy ? 'Instrucción añadida a la cola privada de este browser.' : 'Tarea preparada para este browser.'
      });
      const saved = await this.#saveAndEmit(record, event);
      return this.#snapshot(saved);
    });
    this.#pump();
    return snapshot;
  }

  async pause(browserId: string): Promise<AgentChatSnapshot> {
    await this.#ready();
    return this.#serialize(browserId, async () => {
      const record = await this.#ensureRecord(browserId);
      const active = this.#active.get(browserId);
      if (active) {
        active.worker.pause(active.runId);
        const event = this.#appendEvent(record, {
          taskId: active.taskId,
          runId: active.runId,
          kind: 'state',
          level: 'info',
          summary: 'Pausa solicitada; se aplicará en el siguiente límite seguro entre pasos.'
        });
        return this.#snapshot(await this.#saveAndEmit(record, event));
      }
      if (record.state !== 'paused' && (record.queuedTaskIds.length > 0 || record.activeTaskId)) {
        record.state = 'paused';
        const event = this.#appendEvent(record, {
          taskId: record.activeTaskId ?? record.queuedTaskIds[0] ?? null,
          runId: null,
          kind: 'state',
          level: 'info',
          summary: 'Cola pausada antes de iniciar otra tarea.'
        });
        return this.#snapshot(await this.#saveAndEmit(record, event));
      }
      return this.#snapshot(record);
    });
  }

  async resume(browserId: string): Promise<AgentChatSnapshot> {
    await this.#ready();
    const snapshot = await this.#serialize(browserId, async () => {
      const record = await this.#ensureRecord(browserId);
      const active = this.#active.get(browserId);
      if (active) {
        active.worker.resume(active.runId);
        const event = this.#appendEvent(record, {
          taskId: active.taskId,
          runId: active.runId,
          kind: 'state',
          level: 'info',
          summary: 'Reanudación solicitada.'
        });
        return this.#snapshot(await this.#saveAndEmit(record, event));
      }
      let resumedInterruptedTask = false;
      if (record.activeTaskId) {
        const task = record.tasks.find((candidate) => candidate.id === record.activeTaskId);
        if (task) {
          task.state = 'queued';
          task.outcome = null;
          task.completedAt = null;
          task.updatedAt = this.#timestamp();
          record.queuedTaskIds = [task.id, ...record.queuedTaskIds.filter((id) => id !== task.id)];
          resumedInterruptedTask = true;
        }
        record.activeTaskId = null;
      }
      if (record.queuedTaskIds.length > 0) {
        record.state = 'queued';
        const event = this.#appendEvent(record, {
          taskId: record.queuedTaskIds[0] ?? null,
          runId: null,
          kind: 'state',
          level: 'info',
          summary: resumedInterruptedTask
            ? 'Tarea reanudada con un worker nuevo y una sesión CDP rotada.'
            : 'Cola reanudada.'
        });
        return this.#snapshot(await this.#saveAndEmit(record, event));
      }
      if (record.state === 'paused') {
        record.state = 'idle';
        return this.#snapshot(await this.#saveAndEmit(record));
      }
      return this.#snapshot(record);
    });
    this.#pump();
    return snapshot;
  }

  async stop(browserId: string): Promise<AgentChatSnapshot> {
    await this.#ready();
    const snapshot = await this.#serialize(browserId, async () => {
      const record = await this.#ensureRecord(browserId);
      const active = this.#active.get(browserId);
      const affected = new Set(record.queuedTaskIds);
      if (record.activeTaskId) affected.add(record.activeTaskId);
      if (active) affected.add(active.taskId);
      await this.#releaseActive(active);
      if (affected.size === 0) {
        if (record.state === 'paused' || record.state === 'queued') {
          record.state = 'idle';
          return this.#snapshot(await this.#saveAndEmit(record));
        }
        return this.#snapshot(record);
      }
      const timestamp = this.#timestamp();
      for (const task of record.tasks) {
        if (!affected.has(task.id)) continue;
        task.state = 'completed';
        task.outcome = 'cancelled';
        task.completedAt = timestamp;
        task.updatedAt = timestamp;
      }
      record.queuedTaskIds = [];
      record.activeTaskId = null;
      record.state = 'completed';
      const taskId = active?.taskId ?? [...affected][0] ?? null;
      const summary = affected.size > 1 ? 'Tarea y cola canceladas.' : 'Tarea cancelada.';
      record.messages.push({ id: this.#createId(), role: 'assistant', content: summary, createdAt: timestamp, taskId });
      const event = this.#appendEvent(record, {
        taskId,
        runId: active?.runId ?? null,
        kind: 'result',
        level: 'warning',
        summary: `${summary} Detenido por la persona usuaria.`
      });
      return this.#snapshot(await this.#saveAndEmit(record, event));
    });
    this.#pump();
    return snapshot;
  }

  async getProvider(): Promise<AgentProviderPublic> {
    await this.initialize();
    if (this.#unavailableReason) return { configured: false, baseUrl: null, model: null, hasApiKey: false, keyStorage: null };
    const provider = await this.#providerStore.getPublic();
    // A stored key the keychain refused in this session counts as missing: the dialog asks for it again.
    return provider
      ? {
        configured: this.#providerConfigured,
        baseUrl: provider.baseUrl,
        model: provider.model,
        hasApiKey: this.#providerConfigured,
        keyStorage: this.#providerConfigured ? provider.keyStorage : null
      }
      : { configured: false, baseUrl: null, model: null, hasApiKey: false, keyStorage: null };
  }

  async saveProvider(input: AgentProviderInput): Promise<AgentProviderPublic> {
    await this.#ready();
    const resolved = await this.#resolveProviderInput(input);
    const rememberKey = input.rememberKey ?? true;
    let provider;
    try {
      provider = await this.#providerStore.save(resolved, { rememberKey });
    } catch (error) {
      if (!rememberKey || !isProviderKeyError(error)) throw error;
      // The person denied the keychain (or it is unavailable): the key still works until OmniBrowser closes, and it is
      // never written in clear. The returned keyStorage tells the dialog to explain it.
      provider = await this.#providerStore.save(resolved, { rememberKey: false });
    }
    this.#providerConfigured = true;
    for (const record of this.#records.values()) this.#emitState(this.#summary(record));
    this.#pump();
    return { configured: true, baseUrl: provider.baseUrl, model: provider.model, hasApiKey: true, keyStorage: provider.keyStorage };
  }

  async testProvider(input: AgentProviderInput): Promise<AgentProviderTestResult> {
    await this.#ready();
    const provider = await this.#resolveProviderInput(input);
    let response: Response;
    try {
      // Mirrors the structured-output request Browser Use makes for every step. Sampling parameters are left out because
      // reasoning models reject them.
      response = await this.#fetch(`${provider.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${provider.apiKey}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: provider.model,
          messages: [{ role: 'user', content: 'Return a JSON object with {"ok":true}.' }],
          max_completion_tokens: PROVIDER_TEST_MAX_TOKENS,
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'omnibrowser_provider_check',
              strict: true,
              schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }
            }
          }
        }),
        signal: AbortSignal.timeout(PROVIDER_TEST_TIMEOUT_MS)
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new OmniUserError('conflict', timedOut
        ? `El proveedor no respondió en ${PROVIDER_TEST_TIMEOUT_MS / 1000} segundos.`
        : 'No se pudo conectar con el proveedor. Revisa la URL base y la conexión de red.');
    }
    if (!response.ok) {
      const detail = await providerErrorDetail(response, provider.apiKey);
      throw new OmniUserError('conflict', `El proveedor rechazó la prueba (HTTP ${response.status}${detail ? `: ${detail}` : ''}).`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new OmniUserError('conflict', 'El proveedor respondió, pero su respuesta no es JSON.');
    }
    if (!isRecord(body) || !Array.isArray(body.choices) || body.choices.length === 0) {
      throw new OmniUserError('conflict', 'El proveedor respondió, pero no devolvió el formato OpenAI-compatible esperado.');
    }
    const choice: unknown = body.choices[0];
    const message = isRecord(choice) && isRecord(choice.message) ? choice.message : null;
    const content = message?.content;
    // Browser Use rejects a truncated step before it reads the content, as this check does.
    if (isRecord(choice) && choice.finish_reason === 'length') {
      throw new OmniUserError('conflict', `El modelo agotó los ${PROVIDER_TEST_MAX_TOKENS} tokens de salida antes de terminar su respuesta, probablemente razonando. Browser Use usa ese mismo límite en cada paso: elige un modelo que responda dentro de él.`);
    }
    const reasoningOnly = !(typeof content === 'string' && content.trim())
      && [message?.reasoning, message?.reasoning_content].some((value) => typeof value === 'string' && value.trim().length > 0);
    if (reasoningOnly) {
      throw new OmniUserError('conflict', 'El modelo devolvió solo su razonamiento, sin la respuesta JSON que necesita Browser Use.');
    }
    if (typeof content !== 'string') {
      throw new OmniUserError('conflict', 'El proveedor no devolvió contenido estructurado compatible con Browser Use.');
    }
    try {
      const structured: unknown = JSON.parse(content);
      if (!isRecord(structured) || structured.ok !== true) throw new Error('invalid structured response');
    } catch {
      throw new OmniUserError('conflict', 'El proveedor ignoró o no pudo validar la respuesta JSON estructurada requerida por Browser Use.');
    }
    return { ok: true, message: 'Conexión y respuesta estructurada verificadas.' };
  }

  /** Called by BrowserRuntime whenever a concrete WebContents capability is created or rotated. */
  bindTarget(target: AutomationTarget): void {
    if (this.#disposed || this.#unavailableReason) return;
    const current = this.#targets.get(target.browserId);
    if (!current || target.runtimeEpoch >= current.runtimeEpoch) this.#targets.set(target.browserId, target);
    this.#pump();
  }

  /** Revokes only the matching epoch, so a late callback cannot tear down a replacement WebContents. */
  revokeTarget(target: AutomationTarget, reason: AutomationTargetRevocationReason): void {
    if (this.#disposed) return;
    const current = this.#targets.get(target.browserId);
    if (current?.runtimeEpoch === target.runtimeEpoch) this.#targets.delete(target.browserId);
    void this.#serialize(target.browserId, () => this.#interruptForRevocation(target, reason));
  }

  async removeBrowser(browserId: string): Promise<void> {
    if (!this.#initialized || this.#disposed || this.#unavailableReason) return;
    await this.#serialize(browserId, async () => {
      const active = this.#active.get(browserId);
      await this.#releaseActive(active);
      this.#scheduled.delete(browserId);
      this.#targets.delete(browserId);
      this.#records.delete(browserId);
      await this.#store.delete(browserId);
    });
    this.#pump();
  }

  /** A browser that changes profile starts a new, empty agent; nothing of the previous conversation carries over. */
  async resetForProfile(browserId: string, descriptor: AgentBrowserDescriptor): Promise<void> {
    await this.initialize();
    if (this.#disposed || this.#unavailableReason) return;
    await this.#serialize(browserId, async () => {
      await this.#releaseActive(this.#active.get(browserId));
      this.#scheduled.delete(browserId);
      const previous = this.#records.get(browserId);
      await this.#store.delete(browserId);
      this.#records.delete(browserId);
      if (!previous) return;
      const record = this.#store.createDraft(descriptor);
      this.#records.set(browserId, record);
      this.#emitState(this.#summary(record));
    });
  }

  async prepareTargetRevocation(browserId: string, reason: AutomationTargetRevocationReason): Promise<void> {
    if (!this.#initialized || this.#disposed || this.#unavailableReason) return;
    await this.#serialize(browserId, async () => {
      const target = this.#targets.get(browserId);
      if (target) await this.#interruptForRevocation(target, reason);
      else {
        const active = this.#active.get(browserId);
        if (active) await this.#interruptActive(browserId, active, reason);
      }
    });
  }

  async shutdown(): Promise<void> {
    if (this.#disposed || this.#shuttingDown) return;
    this.#shuttingDown = true;
    await this.#initializing?.catch(() => undefined);
    if (this.#initialized && !this.#unavailableReason) {
      const browserIds = [...new Set([...this.#records.keys(), ...this.#active.keys()])];
      await Promise.all(browserIds.map((browserId) => this.#serialize(browserId, async () => {
        const active = this.#active.get(browserId);
        if (active) {
          await this.#interruptActive(browserId, active, 'shutdown');
          active.worker.terminate();
        }
      })));
    }
    this.#disposed = true;
    for (const [label, step] of [
      ['el historial de agentes', () => this.#store.dispose()],
      ['el proveedor de agentes', () => this.#providerStore.dispose()]
    ] as const) {
      try {
        await step();
      } catch (error) {
        console.error(`[omnibrowser] No se pudo cerrar ${label}:`, error);
      }
    }
  }

  async #ready(): Promise<void> {
    await this.initialize();
    this.#assertActive();
    if (this.#unavailableReason) throw new OmniUserError('conflict', this.#unavailableReason);
  }

  async #ensureRecord(browserId: string): Promise<StoredAgentRecord> {
    const descriptor = this.#getBrowserDescriptor(browserId);
    if (!descriptor) throw new OmniUserError('not-found', 'El browser ya no existe.');
    const current = this.#records.get(browserId);
    if (current && current.profileId === descriptor.profileId && current.persistenceKind === descriptor.persistenceKind) return current;
    // A record left from another profile is never reused. A new one stays in memory until its first save, so merely
    // opening a panel writes nothing.
    if (current) await this.#store.delete(browserId);
    const record = this.#store.createDraft(descriptor);
    this.#records.set(browserId, record);
    return record;
  }

  #interruptRestoredRun(record: StoredAgentRecord): boolean {
    const task = record.activeTaskId ? record.tasks.find((candidate) => candidate.id === record.activeTaskId) : undefined;
    if (!task || (record.state !== 'running' && task.state !== 'running')) return false;
    task.state = 'paused';
    task.outcome = 'interrupted';
    task.updatedAt = this.#timestamp();
    task.progressSummary = this.#interruptedProgress(record, task);
    record.state = 'paused';
    this.#appendEvent(record, {
      taskId: task.id,
      runId: null,
      kind: 'state',
      level: 'warning',
      summary: 'Pausada — interrumpida por reinicio. Reanudar creará un worker y una sesión nuevos.'
    });
    return true;
  }

  #pump(): void {
    if (!this.#initialized || this.#disposed || this.#shuttingDown || this.#unavailableReason || !this.#providerConfigured) return;
    let capacity = this.#maxActiveAgents - this.#active.size - this.#scheduled.size;
    if (capacity <= 0) return;
    for (const record of this.#records.values()) {
      if (capacity <= 0) break;
      if (this.#active.has(record.browserId) || this.#scheduled.has(record.browserId)) continue;
      if (record.state === 'paused' || record.queuedTaskIds.length === 0) continue;
      this.#scheduled.add(record.browserId);
      capacity -= 1;
      void this.#serialize(record.browserId, () => this.#beginNext(record.browserId))
        .catch((error: unknown) => this.#onNotice('error', `No se pudo iniciar un agente: ${errorMessage(error)}`))
        .finally(() => {
          this.#scheduled.delete(record.browserId);
          this.#pump();
        });
    }
  }

  async #beginNext(browserId: string): Promise<void> {
    if (this.#disposed || this.#shuttingDown || this.#active.has(browserId)) return;
    const record = this.#records.get(browserId);
    if (!record || record.state === 'paused') return;
    if (!this.#getBrowserDescriptor(browserId)) {
      // The card is gone and removeBrowser deletes its file; dropping the record keeps the queue from rescheduling it.
      this.#records.delete(browserId);
      return;
    }
    const taskId = record.queuedTaskIds[0];
    if (!taskId) return;
    const task = record.tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      record.queuedTaskIds = record.queuedTaskIds.filter((id) => id !== taskId);
      await this.#saveAndEmit(record);
      return;
    }

    let target: AutomationTarget;
    try {
      const cached = this.#targets.get(browserId);
      target = cached && !cached.contents.isDestroyed() ? cached : this.#acquireTarget(browserId);
      this.#targets.set(browserId, target);
    } catch (error) {
      await this.#failQueuedStart(record, task, error);
      return;
    }
    const runId = this.#createId();
    const gateway = this.#createGateway({
      target,
      onDetached: (reason) => {
        if (reason !== 'crashed') this.#onNotice('warning', `La sesión de automatización de un browser se desconectó (${truncate(reason, 180)}).`);
        this.revokeTarget(target, reason === 'crashed' ? 'crashed' : 'destroyed');
      }
    });
    const worker = this.#createWorker({
      onEvent: (event) => { void this.#serialize(browserId, () => this.#handleWorkerEvent(browserId, runId, event)); },
      onExit: (details) => { void this.#serialize(browserId, () => this.#handleWorkerExit(browserId, runId, details)); }
    });
    const active: ActiveAgentRun = {
      browserId,
      agentId: record.agentId,
      taskId,
      runId,
      runtimeEpoch: target.runtimeEpoch,
      gateway,
      worker,
      lastWorkerSequence: -1,
      terminal: false
    };
    this.#active.set(browserId, active);
    record.queuedTaskIds = record.queuedTaskIds.filter((id) => id !== taskId);
    record.activeTaskId = taskId;
    record.state = 'running';
    const timestamp = this.#timestamp();
    task.state = 'running';
    task.startedAt ??= timestamp;
    task.updatedAt = timestamp;
    task.outcome = null;
    const event = this.#appendEvent(record, {
      taskId,
      runId,
      kind: 'state',
      level: 'info',
      summary: 'Agente iniciado con una capacidad CDP exclusiva para este browser.'
    });
    const saved = await this.#saveAndEmit(record, event);

    try {
      const [cdpUrl, apiKey, provider] = await Promise.all([
        gateway.start(),
        this.#providerStore.revealApiKey(),
        this.#providerStore.getPublic()
      ]);
      if (!apiKey || !provider) throw new OmniUserError('conflict', 'El proveedor de IA no está configurado.');
      if (active.terminal) return;
      const context = this.#workerContext(saved, taskId);
      const workerReady = worker.start({
        runId,
        taskId,
        browserId,
        agentId: record.agentId,
        runtimeEpoch: target.runtimeEpoch,
        instruction: task.instruction,
        ...(context ? { progressSummary: context } : {}),
        cdpUrl,
        model: { baseUrl: provider.baseUrl, model: provider.model, apiKey }
      });
      void workerReady.catch((error: unknown) => this.#serialize(browserId, async () => {
        const current = this.#active.get(browserId);
        const currentRecord = this.#records.get(browserId);
        if (!currentRecord || current !== active || active.terminal) return;
        await this.#finishError(currentRecord, active, this.#startFailureMessage(error));
      }));
    } catch (error) {
      if (isProviderKeyError(error)) this.#providerKeyUnavailable();
      const current = this.#records.get(browserId);
      if (current && this.#active.get(browserId) === active && !active.terminal) {
        await this.#finishError(current, active, this.#startFailureMessage(error));
      }
    }
  }

  #startFailureMessage(error: unknown): string {
    if (error instanceof AgentWorkerError) return workerErrorMessage(error.code);
    if (error instanceof OmniUserError) return error.message;
    if (isProviderKeyError(error)) return PROVIDER_KEY_UNAVAILABLE_MESSAGE;
    return `No se pudo iniciar el agente: ${truncate(errorMessage(error), 300)}`;
  }

  async #failQueuedStart(record: StoredAgentRecord, task: StoredAgentTask, error: unknown): Promise<void> {
    const timestamp = this.#timestamp();
    task.state = 'error';
    task.outcome = 'interrupted';
    task.completedAt = timestamp;
    task.updatedAt = timestamp;
    record.queuedTaskIds = record.queuedTaskIds.filter((id) => id !== task.id);
    record.state = 'error';
    const message = `No se pudo preparar este browser para el agente: ${truncate(errorMessage(error), 1000)}`;
    record.messages.push({ id: this.#createId(), role: 'assistant', content: message, createdAt: timestamp, taskId: task.id });
    const event = this.#appendEvent(record, {
      taskId: task.id,
      runId: null,
      kind: 'error',
      level: 'error',
      summary: message
    });
    await this.#saveAndEmit(record, event);
  }

  async #handleWorkerEvent(browserId: string, runId: string, event: AgentWorkerEvent): Promise<void> {
    if (event.type === 'ready') return;
    const active = this.#active.get(browserId);
    const record = this.#records.get(browserId);
    if (!active || !record || active.runId !== runId || active.terminal) return;
    if (event.runId !== active.runId || event.taskId !== active.taskId || event.browserId !== browserId
      || event.agentId !== active.agentId || event.runtimeEpoch !== active.runtimeEpoch) return;
    if (event.sequence <= active.lastWorkerSequence) return;
    active.lastWorkerSequence = event.sequence;
    const task = record.tasks.find((candidate) => candidate.id === active.taskId);
    if (!task) return;

    if (event.type === 'state') {
      record.state = event.state;
      task.state = event.state;
      task.updatedAt = this.#timestamp();
      const timeline = this.#appendEvent(record, {
        taskId: task.id,
        runId,
        kind: 'state',
        level: 'info',
        summary: event.state === 'paused' ? 'Agente pausado en un límite seguro.' : 'Agente en ejecución.'
      });
      await this.#saveAndEmit(record, timeline);
      return;
    }
    if (event.type === 'action') {
      const timeline = this.#appendEvent(record, {
        taskId: task.id,
        runId,
        kind: 'action',
        level: 'info',
        summary: actionSummary(event)
      });
      await this.#saveAndEmit(record, timeline);
      return;
    }
    if (event.type === 'result') {
      await this.#finishResult(record, active, event.summary, event.outcome);
      return;
    }
    if (event.fatal === false) {
      // For example a pause that arrived just after the run finished: reported, but the run continues.
      const timeline = this.#appendEvent(record, {
        taskId: task.id,
        runId,
        kind: 'state',
        level: 'warning',
        summary: `El runtime ignoró una orden: ${workerErrorMessage(event.code)}`
      });
      await this.#saveAndEmit(record, timeline);
      return;
    }
    await this.#finishError(record, active, workerErrorMessage(event.code, event.diagnostic));
  }

  async #handleWorkerExit(
    browserId: string,
    runId: string,
    details: { code: number | null; signal: NodeJS.Signals | null; diagnostic: string }
  ): Promise<void> {
    const active = this.#active.get(browserId);
    const record = this.#records.get(browserId);
    if (!active || !record || active.runId !== runId || active.terminal) return;
    const suffix = details.signal ? ` (${details.signal})` : details.code === null ? '' : ` (código ${details.code})`;
    if (details.diagnostic) console.warn('[omnibrowser] Agent worker diagnostic fingerprint:', details.diagnostic);
    await this.#finishError(record, active, `El runtime del agente terminó inesperadamente${suffix}.`);
  }

  async #finishResult(
    record: StoredAgentRecord,
    active: ActiveAgentRun,
    summary: string,
    outcome: 'success' | 'cancelled' | 'interrupted'
  ): Promise<void> {
    active.terminal = true;
    this.#active.delete(record.browserId);
    await active.gateway.stop().catch(() => undefined);
    active.worker.dispose();
    const task = record.tasks.find((candidate) => candidate.id === active.taskId);
    const timestamp = this.#timestamp();
    if (task) {
      task.state = 'completed';
      task.outcome = outcome;
      task.completedAt = timestamp;
      task.updatedAt = timestamp;
      delete task.progressSummary;
    }
    record.activeTaskId = null;
    record.state = record.queuedTaskIds.length > 0 ? 'queued' : 'completed';
    const publicSummary = truncate(summary) || (outcome === 'cancelled' ? 'Tarea cancelada.' : 'Tarea completada.');
    record.messages.push({ id: this.#createId(), role: 'assistant', content: publicSummary, createdAt: timestamp, taskId: active.taskId });
    const event = this.#appendEvent(record, {
      taskId: active.taskId,
      runId: active.runId,
      kind: 'result',
      level: outcome === 'success' ? 'info' : 'warning',
      summary: publicSummary
    });
    await this.#saveAndEmit(record, event);
    this.#pump();
  }

  async #finishError(record: StoredAgentRecord, active: ActiveAgentRun, message: string): Promise<void> {
    active.terminal = true;
    this.#active.delete(record.browserId);
    await active.gateway.stop().catch(() => undefined);
    active.worker.terminate();
    const task = record.tasks.find((candidate) => candidate.id === active.taskId);
    const timestamp = this.#timestamp();
    if (task) {
      task.state = 'error';
      task.outcome = 'interrupted';
      task.completedAt = timestamp;
      task.updatedAt = timestamp;
    }
    record.activeTaskId = null;
    record.state = 'error';
    const publicMessage = truncate(message, MAX_AGENT_TIMELINE_SUMMARY_LENGTH) || 'El agente terminó con un error.';
    record.messages.push({ id: this.#createId(), role: 'assistant', content: publicMessage, createdAt: timestamp, taskId: active.taskId });
    const event = this.#appendEvent(record, {
      taskId: active.taskId,
      runId: active.runId,
      kind: 'error',
      level: 'error',
      summary: publicMessage
    });
    await this.#saveAndEmit(record, event);
    this.#pump();
  }

  async #interruptForRevocation(target: AutomationTarget, reason: AutomationTargetRevocationReason): Promise<void> {
    const active = this.#active.get(target.browserId);
    if (!active || active.runtimeEpoch !== target.runtimeEpoch) return;
    await this.#interruptActive(target.browserId, active, reason);
  }

  async #interruptActive(browserId: string, active: ActiveAgentRun, reason: AutomationTargetRevocationReason): Promise<void> {
    const record = this.#records.get(browserId);
    if (!record || this.#active.get(browserId) !== active) return;
    active.terminal = true;
    this.#active.delete(browserId);
    await active.gateway.stop().catch(() => undefined);
    active.worker.stop(active.runId);
    const task = record.tasks.find((candidate) => candidate.id === active.taskId);
    if (task) {
      task.state = 'paused';
      task.outcome = 'interrupted';
      task.updatedAt = this.#timestamp();
      task.progressSummary = this.#interruptedProgress(record, task);
    }
    record.activeTaskId = active.taskId;
    record.state = 'paused';
    const label = reason === 'suspended' ? 'el browser entró en reposo'
      : reason === 'profile-changed' ? 'se cambió el perfil'
        : reason === 'shutdown' ? 'OmniBrowser se cerró'
          : reason === 'crashed' ? 'la página dejó de responder'
            : 'el target dejó de estar disponible';
    const event = this.#appendEvent(record, {
      taskId: active.taskId,
      runId: active.runId,
      kind: 'state',
      level: 'warning',
      summary: `Tarea pausada porque ${label}. La próxima reanudación usará una sesión nueva.`
    });
    await this.#saveAndEmit(record, event);
    this.#pump();
  }

  async #releaseActive(active: ActiveAgentRun | undefined): Promise<void> {
    if (!active) return;
    active.terminal = true;
    this.#active.delete(active.browserId);
    await active.gateway.stop().catch(() => undefined);
    active.worker.stop(active.runId);
  }

  async #resolveProviderInput(input: AgentProviderInput): Promise<{ baseUrl: string; model: string; apiKey: string }> {
    let baseUrl: string;
    try {
      baseUrl = normalizeProviderBaseUrl(input.baseUrl);
    } catch (error) {
      throw new OmniUserError('invalid-input', error instanceof Error ? error.message : 'La URL base del proveedor no es válida.');
    }
    let apiKey = input.apiKey?.trim() ?? '';
    if (!apiKey) {
      const stored = await this.#providerStore.getPublic();
      // The stored key is only ever sent to the endpoint it was saved for; another origin needs the key typed again.
      if (stored && new URL(stored.baseUrl).origin !== new URL(baseUrl).origin) {
        throw new OmniUserError('invalid-input', 'Introduce la clave API de nuevo para usar otro proveedor.');
      }
      try {
        apiKey = (await this.#providerStore.revealApiKey()) ?? '';
      } catch (error) {
        if (!isProviderKeyError(error)) throw new OmniUserError('conflict', errorMessage(error));
        this.#providerKeyUnavailable();
        throw new OmniUserError('conflict', PROVIDER_KEY_UNAVAILABLE_MESSAGE);
      }
    }
    if (!apiKey) throw new OmniUserError('invalid-input', 'Introduce una clave API para configurar el proveedor.');
    try {
      return validateAgentProviderInput({ baseUrl, model: input.model, apiKey });
    } catch {
      throw new OmniUserError('invalid-input', 'El modelo o la clave API contienen caracteres no válidos.');
    }
  }

  /**
   * The stored key cannot be read in this session: the cards ask for a provider again instead of failing every queued
   * task. Typing the key keeps it for the session even while the keychain is refused.
   */
  #providerKeyUnavailable(): void {
    if (!this.#providerConfigured) return;
    this.#providerConfigured = false;
    for (const record of this.#records.values()) this.#emitState(this.#summary(record));
  }

  /** Earlier turns of this card's chat and the progress of an interrupted task, newest last. */
  #workerContext(record: StoredAgentRecord, taskId: string): string | undefined {
    const task = record.tasks.find((candidate) => candidate.id === taskId);
    const firstMessage = record.messages.findIndex((message) => message.taskId === taskId && message.role === 'user');
    const earlier = (firstMessage < 0 ? record.messages : record.messages.slice(0, firstMessage))
      .filter((message) => message.taskId !== taskId)
      .slice(-CONTEXT_MESSAGE_COUNT)
      .map((message) => `${message.role === 'user' ? 'User' : 'Agent'}: ${truncate(message.content.replace(/\s+/g, ' '), CONTEXT_MESSAGE_LENGTH)}`);
    const blocks: string[] = [];
    if (earlier.length > 0) blocks.push(`Earlier conversation in this card:\n${earlier.join('\n')}`);
    if (task?.progressSummary) blocks.push(`This task was interrupted after these steps:\n${task.progressSummary}`);
    return blocks.length > 0 ? truncateHead(blocks.join('\n\n'), MAX_AGENT_PROGRESS_SUMMARY_LENGTH) : undefined;
  }

  #appendEvent(
    record: StoredAgentRecord,
    input: Omit<StoredAgentTimelineEvent, 'id' | 'browserId' | 'agentId' | 'sequence' | 'createdAt'>
  ): StoredAgentTimelineEvent {
    record.sequence += 1;
    const createdAt = this.#timestamp();
    const event: StoredAgentTimelineEvent = {
      id: this.#createId(),
      browserId: record.browserId,
      agentId: record.agentId,
      sequence: record.sequence,
      createdAt,
      ...input,
      summary: truncate(input.summary, MAX_AGENT_TIMELINE_SUMMARY_LENGTH)
    };
    record.timeline.push(event);
    record.updatedAt = createdAt;
    return event;
  }

  async #saveAndEmit(record: StoredAgentRecord, event?: StoredAgentTimelineEvent): Promise<StoredAgentRecord> {
    const saved = await this.#store.save(record);
    this.#records.set(saved.browserId, saved);
    if (event) this.#emitEvent(event);
    this.#emitState(this.#summary(saved));
    return saved;
  }

  #summary(record: StoredAgentRecord): AgentSummary {
    return {
      browserId: record.browserId,
      agentId: record.agentId,
      chatSessionId: record.chatSessionId,
      state: record.state,
      activeTaskId: record.activeTaskId,
      queuedTaskCount: record.queuedTaskIds.length,
      sequence: record.sequence,
      updatedAt: record.updatedAt,
      requiresProvider: !this.#providerConfigured
    };
  }

  #snapshot(record: StoredAgentRecord): AgentChatSnapshot {
    return {
      summary: this.#summary(record),
      messages: structuredClone(record.messages),
      // Interrupted progress is context for the next worker, not part of the renderer contract.
      tasks: record.tasks.map((task) => {
        const copy = structuredClone(task);
        delete copy.progressSummary;
        return copy;
      }),
      timeline: structuredClone(record.timeline),
      conversationSummary: record.conversationSummary
    };
  }

  /** The last actions of a task, merged with those of earlier interruptions of the same task. */
  #interruptedProgress(record: StoredAgentRecord, task: StoredAgentTask): string | undefined {
    const recentActions = record.timeline
      .filter((event) => event.taskId === task.id && event.kind === 'action')
      .slice(-PROGRESS_ACTION_COUNT)
      .map((event) => `- ${event.summary}`);
    if (recentActions.length === 0) return task.progressSummary;
    const combined = task.progressSummary ? `${task.progressSummary}\n${recentActions.join('\n')}` : recentActions.join('\n');
    return truncateHead(combined, MAX_AGENT_PROGRESS_SUMMARY_LENGTH);
  }

  #serialize<T>(browserId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#browserOperations.get(browserId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.#browserOperations.set(browserId, current);
    void current.finally(() => {
      if (this.#browserOperations.get(browserId) === current) this.#browserOperations.delete(browserId);
    }).catch(() => undefined);
    return current;
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }

  #assertActive(): void {
    if (this.#disposed || this.#shuttingDown) throw new OmniUserError('conflict', 'OmniBrowser se está cerrando.');
  }
}
