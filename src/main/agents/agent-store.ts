import { randomUUID } from 'node:crypto';
import { chmod, lstat, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  AGENT_STORE_SCHEMA_VERSION,
  MAX_AGENT_INSTRUCTION_LENGTH,
  MAX_AGENT_MESSAGE_LENGTH,
  MAX_AGENT_PROGRESS_SUMMARY_LENGTH,
  MAX_AGENT_TIMELINE_SUMMARY_LENGTH
} from '../../shared/constants';
import { preserveCorruptFile, readSecureText, writeSecureTextAtomically } from './secure-storage';

export { AGENT_STORE_SCHEMA_VERSION };
export const MAX_AGENT_RECORD_BYTES = 1024 * 1024;
export const MAX_AGENT_MESSAGES = 200;
export const MAX_AGENT_TIMELINE_EVENTS = 500;
export const MAX_AGENT_TASKS = 50;

const MAX_RAW_COLLECTION_LENGTH = 10_000;
const MAX_PERSISTED_TEXT_LENGTH = MAX_AGENT_RECORD_BYTES;
const MAX_MESSAGE_LENGTH = MAX_AGENT_MESSAGE_LENGTH;
const MAX_TASK_INSTRUCTION_LENGTH = MAX_AGENT_INSTRUCTION_LENGTH;
const MAX_TIMELINE_SUMMARY_LENGTH = MAX_AGENT_TIMELINE_SUMMARY_LENGTH;
const MAX_CONVERSATION_SUMMARY_LENGTH = 32 * 1024;
const uuidSchema = z.string().uuid();
const isoDateSchema = z.string().datetime({ offset: true });
const persistedTextSchema = z.string().max(MAX_PERSISTED_TEXT_LENGTH);

export const storedAgentRunStateSchema = z.enum(['idle', 'queued', 'running', 'paused', 'completed', 'error']);
export type StoredAgentRunState = z.infer<typeof storedAgentRunStateSchema>;

export const storedAgentTaskStateSchema = z.enum(['queued', 'running', 'paused', 'completed', 'error']);
export type StoredAgentTaskState = z.infer<typeof storedAgentTaskStateSchema>;

export const storedAgentMessageSchema = z.object({
  id: uuidSchema,
  role: z.enum(['user', 'assistant']),
  content: persistedTextSchema,
  createdAt: isoDateSchema,
  taskId: uuidSchema.nullable()
}).strict();
export type StoredAgentMessage = z.infer<typeof storedAgentMessageSchema>;

export const storedAgentTaskSchema = z.object({
  id: uuidSchema,
  instruction: persistedTextSchema,
  state: storedAgentTaskStateSchema,
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
  startedAt: isoDateSchema.nullable(),
  completedAt: isoDateSchema.nullable(),
  outcome: z.enum(['success', 'cancelled', 'interrupted']).nullable(),
  // Actions completed before this task was interrupted; handed to the next worker so a resumed task does not restart.
  progressSummary: persistedTextSchema.optional()
}).strict();
export type StoredAgentTask = z.infer<typeof storedAgentTaskSchema>;

export const storedAgentTimelineEventSchema = z.object({
  id: uuidSchema,
  browserId: uuidSchema,
  agentId: uuidSchema,
  taskId: uuidSchema.nullable(),
  runId: uuidSchema.nullable(),
  sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  kind: z.enum(['state', 'action', 'result', 'error']),
  level: z.enum(['info', 'warning', 'error']),
  summary: persistedTextSchema,
  createdAt: isoDateSchema
}).strict();
export type StoredAgentTimelineEvent = z.infer<typeof storedAgentTimelineEventSchema>;

const storedAgentRecordShape = {
  schemaVersion: z.literal(AGENT_STORE_SCHEMA_VERSION),
  browserId: uuidSchema,
  agentId: uuidSchema,
  chatSessionId: uuidSchema,
  profileId: uuidSchema,
  persistenceKind: z.enum(['persistent', 'private']),
  state: storedAgentRunStateSchema,
  activeTaskId: uuidSchema.nullable(),
  queuedTaskIds: z.array(uuidSchema).max(MAX_RAW_COLLECTION_LENGTH),
  sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  messages: z.array(storedAgentMessageSchema).max(MAX_RAW_COLLECTION_LENGTH),
  tasks: z.array(storedAgentTaskSchema).max(MAX_RAW_COLLECTION_LENGTH),
  timeline: z.array(storedAgentTimelineEventSchema).max(MAX_RAW_COLLECTION_LENGTH),
  conversationSummary: persistedTextSchema,
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema
} as const;

const rawStoredAgentRecordSchema = z.object(storedAgentRecordShape).strict();

export const storedAgentRecordSchema = z.object({
  ...storedAgentRecordShape,
  queuedTaskIds: z.array(uuidSchema).max(MAX_AGENT_TASKS),
  messages: z.array(storedAgentMessageSchema).max(MAX_AGENT_MESSAGES),
  tasks: z.array(storedAgentTaskSchema).max(MAX_AGENT_TASKS),
  timeline: z.array(storedAgentTimelineEventSchema).max(MAX_AGENT_TIMELINE_EVENTS)
}).strict().superRefine((record, context) => {
  const taskIds = new Set(record.tasks.map((task) => task.id));
  if (record.activeTaskId !== null && !taskIds.has(record.activeTaskId)) {
    context.addIssue({ code: 'custom', path: ['activeTaskId'], message: 'La tarea activa no existe en tasks.' });
  }
  const queuedIds = new Set<string>();
  record.queuedTaskIds.forEach((taskId, index) => {
    if (!taskIds.has(taskId)) context.addIssue({ code: 'custom', path: ['queuedTaskIds', index], message: 'La tarea en cola no existe en tasks.' });
    if (queuedIds.has(taskId)) context.addIssue({ code: 'custom', path: ['queuedTaskIds', index], message: 'La tarea está repetida en la cola.' });
    queuedIds.add(taskId);
  });
  let previousSequence = 0;
  record.timeline.forEach((event, index) => {
    if (event.browserId !== record.browserId) context.addIssue({ code: 'custom', path: ['timeline', index, 'browserId'], message: 'El evento pertenece a otro browser.' });
    if (event.agentId !== record.agentId) context.addIssue({ code: 'custom', path: ['timeline', index, 'agentId'], message: 'El evento pertenece a otro agente.' });
    if (event.sequence <= previousSequence) context.addIssue({ code: 'custom', path: ['timeline', index, 'sequence'], message: 'La secuencia del timeline no es creciente.' });
    if (event.sequence > record.sequence) context.addIssue({ code: 'custom', path: ['timeline', index, 'sequence'], message: 'El evento supera la secuencia del registro.' });
    previousSequence = event.sequence;
  });
});
export type StoredAgentRecord = z.infer<typeof storedAgentRecordSchema>;

const descriptorSchema = z.object({ browserId: uuidSchema, profileId: uuidSchema, persistenceKind: z.enum(['persistent', 'private']) }).strict();

export interface AgentBrowserDescriptor {
  browserId: string;
  profileId: string;
  persistenceKind: 'persistent' | 'private';
}

export interface AgentStoreDiagnostic {
  browserId: string;
  message: string;
  preservedPath?: string;
}

export interface AgentStoreLoadResult {
  record: StoredAgentRecord | null;
  source: 'disk' | 'memory' | 'new';
  diagnostic?: AgentStoreDiagnostic;
}

export interface AgentStoreOptions {
  now?: () => Date;
  createId?: () => string;
}

function cloneRecord(record: StoredAgentRecord): StoredAgentRecord {
  return structuredClone(record);
}

function redactPersistedText(value: string): string {
  return value
    .replace(/\bsk-[a-z0-9_-]{12,}\b/gi, '[REDACTED]')
    .replace(/(bearer\s+)[a-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]')
    .replace(/((?:api[_ -]?key|authorization|password|secret|token|cookie)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\b(?:wss?|https?):\/\/(?:127(?:\.\d{1,3}){3}|localhost|\[::1\])(?::\d+)?\/[a-z0-9_-]{16,}\b/gi, '[REDACTED_CAPABILITY_URL]');
}

function limitText(value: string, maxLength: number): string {
  const redacted = redactPersistedText(value);
  if (redacted.length <= maxLength) return redacted;
  return `${redacted.slice(0, Math.max(0, maxLength - 14))}\n[TRUNCATED]`;
}

function appendCompactedMessages(summary: string, removed: readonly StoredAgentMessage[]): string {
  if (removed.length === 0) return limitText(summary, MAX_CONVERSATION_SUMMARY_LENGTH);
  const excerpts = removed.slice(-50).map((message) => {
    const singleLine = message.content.replace(/\s+/g, ' ').trim();
    return `${message.role === 'user' ? 'Usuario' : 'Agente'}: ${limitText(singleLine, 180)}`;
  });
  const block = `[${removed.length} mensajes anteriores compactados]\n${excerpts.join('\n')}`;
  const combined = summary.length > 0 ? `${summary}\n${block}` : block;
  if (combined.length <= MAX_CONVERSATION_SUMMARY_LENGTH) return redactPersistedText(combined);
  const tailLength = MAX_CONVERSATION_SUMMARY_LENGTH - 29;
  return `[Resumen anterior truncado]\n${redactPersistedText(combined).slice(-tailLength)}`;
}

function selectTasks(record: z.infer<typeof rawStoredAgentRecordSchema>): StoredAgentTask[] {
  const availableIds = new Set(record.tasks.map((task) => task.id));
  const selected = new Set<string>();
  if (record.activeTaskId !== null && availableIds.has(record.activeTaskId)) selected.add(record.activeTaskId);
  for (let index = record.queuedTaskIds.length - 1; index >= 0 && selected.size < MAX_AGENT_TASKS; index -= 1) {
    const taskId = record.queuedTaskIds[index];
    if (taskId && availableIds.has(taskId)) selected.add(taskId);
  }
  for (let index = record.tasks.length - 1; index >= 0 && selected.size < MAX_AGENT_TASKS; index -= 1) {
    const task = record.tasks[index];
    if (task) selected.add(task.id);
  }
  return record.tasks.filter((task) => selected.has(task.id)).map((task) => ({
    ...task,
    instruction: limitText(task.instruction, MAX_TASK_INSTRUCTION_LENGTH),
    ...(task.progressSummary === undefined ? {} : { progressSummary: limitText(task.progressSummary, MAX_AGENT_PROGRESS_SUMMARY_LENGTH) })
  }));
}

function serialize(record: StoredAgentRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

function byteLength(record: StoredAgentRecord): number {
  return Buffer.byteLength(serialize(record), 'utf8');
}

function removeOldestRemovableTask(record: StoredAgentRecord): boolean {
  if (record.tasks.length <= 1) return false;
  const protectedIds = new Set(record.queuedTaskIds);
  if (record.activeTaskId !== null) protectedIds.add(record.activeTaskId);
  const index = record.tasks.findIndex((task) => !protectedIds.has(task.id));
  if (index < 0) return false;
  record.tasks.splice(index, 1);
  return true;
}

function applyTextBudget(record: StoredAgentRecord, maxLength: number): void {
  record.conversationSummary = limitText(record.conversationSummary, Math.min(maxLength, MAX_CONVERSATION_SUMMARY_LENGTH));
  record.messages = record.messages.map((message) => ({ ...message, content: limitText(message.content, maxLength) }));
  record.tasks = record.tasks.map((task) => ({
    ...task,
    instruction: limitText(task.instruction, maxLength),
    ...(task.progressSummary === undefined ? {} : { progressSummary: limitText(task.progressSummary, maxLength) })
  }));
  record.timeline = record.timeline.map((event) => ({ ...event, summary: limitText(event.summary, Math.min(maxLength, MAX_TIMELINE_SUMMARY_LENGTH)) }));
}

function prepareRecord(input: StoredAgentRecord, maxBytes = MAX_AGENT_RECORD_BYTES): { record: StoredAgentRecord; serialized: string } {
  const raw = rawStoredAgentRecordSchema.parse(input);
  const removedMessages = raw.messages.slice(0, Math.max(0, raw.messages.length - MAX_AGENT_MESSAGES));
  const tasks = selectTasks(raw);
  const taskIds = new Set(tasks.map((task) => task.id));
  const record = {
    ...raw,
    activeTaskId: raw.activeTaskId !== null && taskIds.has(raw.activeTaskId) ? raw.activeTaskId : null,
    queuedTaskIds: raw.queuedTaskIds.filter((taskId, index, values) => taskIds.has(taskId) && values.indexOf(taskId) === index).slice(-MAX_AGENT_TASKS),
    messages: raw.messages.slice(-MAX_AGENT_MESSAGES).map((message) => ({
      ...message,
      content: limitText(message.content, MAX_MESSAGE_LENGTH)
    })),
    tasks,
    timeline: raw.timeline.slice(-MAX_AGENT_TIMELINE_EVENTS).map((event) => ({
      ...event,
      summary: limitText(event.summary, MAX_TIMELINE_SUMMARY_LENGTH)
    })),
    conversationSummary: appendCompactedMessages(raw.conversationSummary, removedMessages)
  } satisfies StoredAgentRecord;

  while (byteLength(record) > maxBytes && record.timeline.length > 1) record.timeline.shift();
  while (byteLength(record) > maxBytes && removeOldestRemovableTask(record)) {
    // Remove terminal history before sacrificing visible conversation content.
  }
  while (byteLength(record) > maxBytes && record.messages.length > 1) {
    const removed = record.messages.shift();
    if (removed) record.conversationSummary = appendCompactedMessages(record.conversationSummary, [removed]);
  }
  for (const textLimit of [16_384, 8192, 4096, 2048, 1024, 512, 256, 128]) {
    if (byteLength(record) <= maxBytes) break;
    applyTextBudget(record, textLimit);
  }
  if (byteLength(record) > maxBytes) {
    record.conversationSummary = '';
    record.timeline = [];
  }
  const validated = storedAgentRecordSchema.parse(record);
  const serialized = serialize(validated);
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new Error('El registro del agente supera el límite de tamaño incluso después de compactarlo.');
  }
  return { record: validated, serialized };
}

export function compactStoredAgentRecord(record: StoredAgentRecord, maxBytes = MAX_AGENT_RECORD_BYTES): StoredAgentRecord {
  return prepareRecord(record, maxBytes).record;
}

export function serializeStoredAgentRecord(record: StoredAgentRecord, maxBytes = MAX_AGENT_RECORD_BYTES): string {
  return prepareRecord(record, maxBytes).serialized;
}

export function createStoredAgentRecord(
  descriptor: AgentBrowserDescriptor,
  options: { now?: Date; agentId?: string; chatSessionId?: string } = {}
): StoredAgentRecord {
  const timestamp = (options.now ?? new Date()).toISOString();
  return storedAgentRecordSchema.parse({
    schemaVersion: AGENT_STORE_SCHEMA_VERSION,
    browserId: descriptor.browserId,
    agentId: options.agentId ?? randomUUID(),
    chatSessionId: options.chatSessionId ?? randomUUID(),
    profileId: descriptor.profileId,
    persistenceKind: descriptor.persistenceKind,
    state: 'idle',
    activeTaskId: null,
    queuedTaskIds: [],
    sequence: 0,
    messages: [],
    tasks: [],
    timeline: [],
    conversationSummary: '',
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

type ReadResult =
  | { status: 'missing' }
  | { status: 'valid'; record: StoredAgentRecord; serialized: string; needsRewrite: boolean }
  | { status: 'invalid'; reason: string };

async function readRecord(filePath: string, expectedBrowserId: string): Promise<ReadResult> {
  const candidate = await readSecureText(filePath, MAX_AGENT_RECORD_BYTES);
  if (candidate.status !== 'valid') return candidate;
  try {
    const raw = rawStoredAgentRecordSchema.parse(JSON.parse(candidate.source) as unknown);
    if (raw.browserId !== expectedBrowserId) return { status: 'invalid', reason: 'El browserId del archivo no coincide con su nombre.' };
    if (raw.persistenceKind !== 'persistent') return { status: 'invalid', reason: 'Un agente Private no puede existir en disco.' };
    const prepared = prepareRecord(raw);
    return { status: 'valid', ...prepared, needsRewrite: candidate.source !== prepared.serialized };
  } catch (error) {
    return { status: 'invalid', reason: error instanceof Error ? error.message : String(error) };
  }
}

export class AgentStore {
  readonly directory: string;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #persistent = new Map<string, StoredAgentRecord>();
  readonly #private = new Map<string, StoredAgentRecord>();
  readonly #diagnostics = new Map<string, AgentStoreDiagnostic>();
  readonly #writes = new Map<string, Promise<void>>();
  #initializing: Promise<readonly AgentStoreDiagnostic[]> | null = null;
  #initialized = false;
  #disposed = false;

  constructor(userDataDirectory: string, options: AgentStoreOptions = {}) {
    this.directory = path.join(userDataDirectory, 'agents');
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
  }

  pathFor(browserId: string): string {
    return path.join(this.directory, `${uuidSchema.parse(browserId)}.json`);
  }

  async initialize(): Promise<readonly AgentStoreDiagnostic[]> {
    this.#assertActive();
    if (this.#initialized) return this.diagnostics();
    if (this.#initializing) return this.#initializing;
    this.#initializing = this.#initializeFromDisk();
    try {
      return await this.#initializing;
    } finally {
      this.#initializing = null;
    }
  }

  async #initializeFromDisk(): Promise<readonly AgentStoreDiagnostic[]> {
    let names: string[];
    try {
      const metadata = await lstat(this.directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('agents no es un directorio seguro.');
      await chmod(this.directory, 0o700);
      names = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.#initialized = true;
        return [];
      }
      throw error;
    }

    const candidates = names
      .filter((name) => name.endsWith('.json'))
      .map((name) => ({ name, browserId: name.slice(0, -'.json'.length) }))
      .filter(({ browserId }) => uuidSchema.safeParse(browserId).success)
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const candidate of candidates) {
      const filePath = this.pathFor(candidate.browserId);
      const result = await readRecord(filePath, candidate.browserId);
      if (result.status === 'valid') {
        this.#persistent.set(candidate.browserId, result.record);
        if (result.needsRewrite) await writeSecureTextAtomically(this.directory, filePath, result.serialized);
      } else if (result.status === 'invalid') {
        await this.#recordCorruption(candidate.browserId, filePath, result.reason);
      }
    }
    this.#initialized = true;
    return this.diagnostics();
  }

  async load(browserId: string, fallback?: Omit<AgentBrowserDescriptor, 'browserId'>): Promise<AgentStoreLoadResult> {
    const validatedBrowserId = uuidSchema.parse(browserId);
    await this.initialize();
    const privateRecord = this.#private.get(validatedBrowserId);
    if (privateRecord) return { record: cloneRecord(privateRecord), source: 'memory', diagnostic: this.#diagnostics.get(validatedBrowserId) };
    const persistentRecord = this.#persistent.get(validatedBrowserId);
    if (persistentRecord) return { record: cloneRecord(persistentRecord), source: 'disk', diagnostic: this.#diagnostics.get(validatedBrowserId) };
    if (fallback) {
      const record = await this.ensure({ browserId: validatedBrowserId, ...fallback });
      return { record, source: 'new', diagnostic: this.#diagnostics.get(validatedBrowserId) };
    }
    return { record: null, source: 'new', diagnostic: this.#diagnostics.get(validatedBrowserId) };
  }

  async list(): Promise<StoredAgentRecord[]> {
    await this.initialize();
    return [...this.#persistent.values(), ...this.#private.values()]
      .sort((left, right) => left.browserId.localeCompare(right.browserId))
      .map(cloneRecord);
  }

  diagnostics(): readonly AgentStoreDiagnostic[] {
    return [...this.#diagnostics.values()].sort((left, right) => left.browserId.localeCompare(right.browserId));
  }

  /** A new, empty record that exists only in the caller's memory until it is saved. */
  createDraft(descriptor: AgentBrowserDescriptor): StoredAgentRecord {
    this.#assertActive();
    const validated = descriptorSchema.parse(descriptor);
    return createStoredAgentRecord(validated, {
      now: this.#now(),
      agentId: this.#createId(),
      chatSessionId: this.#createId()
    });
  }

  async ensure(descriptor: AgentBrowserDescriptor): Promise<StoredAgentRecord> {
    const validated = descriptorSchema.parse(descriptor);
    await this.initialize();
    const existing = this.#private.get(validated.browserId) ?? this.#persistent.get(validated.browserId);
    if (existing && existing.profileId === validated.profileId && existing.persistenceKind === validated.persistenceKind) return cloneRecord(existing);
    if (existing) return this.resetForProfile(validated.browserId, validated.profileId, validated.persistenceKind);
    const record = createStoredAgentRecord(validated, {
      now: this.#now(),
      agentId: this.#createId(),
      chatSessionId: this.#createId()
    });
    return this.save(record);
  }

  async save(input: StoredAgentRecord): Promise<StoredAgentRecord> {
    this.#assertActive();
    await this.initialize();
    const { record, serialized } = prepareRecord(input);
    if (record.persistenceKind === 'private') {
      await this.#enqueue(record.browserId, async () => {
        await unlink(this.pathFor(record.browserId)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      });
      this.#persistent.delete(record.browserId);
      this.#private.set(record.browserId, record);
      return cloneRecord(record);
    }
    await this.#enqueue(record.browserId, async () => {
      await writeSecureTextAtomically(this.directory, this.pathFor(record.browserId), serialized);
    });
    this.#private.delete(record.browserId);
    this.#persistent.set(record.browserId, record);
    return cloneRecord(record);
  }

  async delete(browserId: string): Promise<boolean> {
    this.#assertActive();
    const validatedBrowserId = uuidSchema.parse(browserId);
    await this.initialize();
    const existed = this.#persistent.has(validatedBrowserId) || this.#private.has(validatedBrowserId);
    await this.#enqueue(validatedBrowserId, async () => {
      await unlink(this.pathFor(validatedBrowserId)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    });
    this.#persistent.delete(validatedBrowserId);
    this.#private.delete(validatedBrowserId);
    this.#diagnostics.delete(validatedBrowserId);
    return existed;
  }

  async resetForProfile(browserId: string, profileId: string, persistenceKind: 'persistent' | 'private'): Promise<StoredAgentRecord> {
    this.#assertActive();
    const descriptor = descriptorSchema.parse({ browserId, profileId, persistenceKind });
    await this.delete(descriptor.browserId);
    const record = createStoredAgentRecord(descriptor, {
      now: this.#now(),
      agentId: this.#createId(),
      chatSessionId: this.#createId()
    });
    return this.save(record);
  }

  /**
   * Deletes the records of browsers that no longer exist, or that now belong to another profile, and returns the rest.
   * Records are created on first use, so a workspace with many cards never writes one file per card at startup.
   */
  async reconcile(descriptors: readonly AgentBrowserDescriptor[]): Promise<StoredAgentRecord[]> {
    this.#assertActive();
    await this.initialize();
    const byBrowserId = new Map<string, AgentBrowserDescriptor>();
    for (const descriptor of descriptors.map((candidate) => descriptorSchema.parse(candidate))) {
      if (byBrowserId.has(descriptor.browserId)) throw new Error(`Browser duplicado en reconcile: ${descriptor.browserId}`);
      byBrowserId.set(descriptor.browserId, descriptor);
    }
    const existing = [...this.#persistent.values(), ...this.#private.values()];
    const stale = existing.filter((record) => {
      const descriptor = byBrowserId.get(record.browserId);
      return !descriptor || descriptor.profileId !== record.profileId || descriptor.persistenceKind !== record.persistenceKind;
    });
    await Promise.all(stale.map((record) => this.delete(record.browserId)));
    return this.list();
  }

  async flush(): Promise<void> {
    while (this.#writes.size > 0) await Promise.all([...this.#writes.values()]);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    await this.flush();
    this.#private.clear();
    this.#disposed = true;
  }

  async #recordCorruption(browserId: string, filePath: string, reason: string): Promise<void> {
    let preservedPath: string | null = null;
    let preservationError: string | undefined;
    try {
      preservedPath = await preserveCorruptFile(filePath, this.#now(), this.#createId().slice(0, 8));
    } catch (error) {
      preservationError = error instanceof Error ? error.message : String(error);
    }
    const suffix = preservedPath
      ? ` Se conservó sin cambios como ${path.basename(preservedPath)}.`
      : preservationError
        ? ` No se pudo preservar todavía (${preservationError}).`
        : '';
    this.#diagnostics.set(browserId, {
      browserId,
      message: `${path.basename(filePath)} no era válido (${reason}).${suffix}`,
      ...(preservedPath ? { preservedPath } : {})
    });
  }

  #enqueue(browserId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.#writes.get(browserId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.#writes.set(browserId, current);
    void current.finally(() => {
      if (this.#writes.get(browserId) === current) this.#writes.delete(browserId);
    }).catch(() => undefined);
    return current;
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('AgentStore ya fue cerrado.');
  }
}
