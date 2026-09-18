import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { preserveCorruptFile, readSecureText, writeSecureTextAtomically } from './secure-storage';

export const PROVIDER_STORE_SCHEMA_VERSION = 1;
export const MAX_PROVIDER_FILE_BYTES = 64 * 1024;

const MAX_PROVIDER_BASE_URL_LENGTH = 2048;
const MAX_PROVIDER_MODEL_LENGTH = 200;
const MAX_PROVIDER_API_KEY_LENGTH = 16 * 1024;
const isoDateSchema = z.string().datetime({ offset: true });

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
}

export interface SafeStorageAdapter {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface AgentProviderInput {
  baseUrl: string;
  model: string;
  apiKey: string;
}

/**
 * Where the API key lives: encrypted with the system keychain, or only in main-process memory until OmniBrowser closes
 * (the person chose not to remember it, or macOS denied the keychain). A session key never reaches the disk.
 */
export type ProviderKeyStorage = 'encrypted' | 'session' | null;

export interface AgentProviderPublic {
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  keyStorage: ProviderKeyStorage;
  updatedAt: string;
}

export interface ProviderSaveOptions {
  /** false keeps the key in memory for this session only, without touching the keychain. Defaults to true. */
  rememberKey?: boolean;
}

export interface ProviderStoreLoadResult {
  provider: AgentProviderPublic | null;
  warning?: string;
}

export class ProviderEncryptionUnavailableError extends Error {
  constructor() {
    super('El llavero del sistema no está disponible para cifrar o leer la clave del proveedor.');
    this.name = 'ProviderEncryptionUnavailableError';
  }
}

export class ProviderDecryptionError extends Error {
  constructor() {
    super('No se pudo descifrar la clave del proveedor con el llavero del sistema.');
    this.name = 'ProviderDecryptionError';
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized === '::1'
    || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

export function normalizeProviderBaseUrl(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PROVIDER_BASE_URL_LENGTH) throw new Error('La URL base del proveedor no es válida.');
  if (trimmed.includes('?') || trimmed.includes('#')) throw new Error('La URL base del proveedor no puede incluir query ni fragmento.');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('La URL base del proveedor no es válida.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('La URL base del proveedor debe usar http o https.');
  if (url.username.length > 0 || url.password.length > 0) throw new Error('La URL base del proveedor no puede incluir credenciales.');
  if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) {
    throw new Error('HTTP solo está permitido para proveedores en loopback; usa HTTPS para endpoints remotos.');
  }
  const normalized = url.toString();
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

const providerInputSchema = z.object({
  baseUrl: z.string(),
  model: z.string().trim().min(1).max(MAX_PROVIDER_MODEL_LENGTH).refine((value) => !containsControlCharacter(value), 'El modelo contiene caracteres de control.'),
  apiKey: z.string().trim().min(1).max(MAX_PROVIDER_API_KEY_LENGTH).refine((value) => !containsControlCharacter(value), 'La clave contiene caracteres de control.')
}).strict();

export function validateAgentProviderInput(input: AgentProviderInput): AgentProviderInput {
  const parsed = providerInputSchema.parse(input);
  return { ...parsed, baseUrl: normalizeProviderBaseUrl(parsed.baseUrl) };
}

const storedProviderSchema = z.object({
  schemaVersion: z.literal(PROVIDER_STORE_SCHEMA_VERSION),
  baseUrl: z.string().min(1).max(MAX_PROVIDER_BASE_URL_LENGTH),
  model: z.string().min(1).max(MAX_PROVIDER_MODEL_LENGTH),
  // Absent when the key was only used for a session: the endpoint and model are remembered, the key is asked again.
  encryptedApiKey: z.string().min(1).max(MAX_PROVIDER_FILE_BYTES).regex(/^[a-z0-9+/]+={0,2}$/i).optional(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema
}).strict();
type StoredProvider = z.infer<typeof storedProviderSchema>;

function toPublic(record: StoredProvider, sessionApiKey: string | null): AgentProviderPublic {
  const keyStorage: ProviderKeyStorage = sessionApiKey ? 'session' : record.encryptedApiKey ? 'encrypted' : null;
  return {
    baseUrl: record.baseUrl,
    model: record.model,
    hasApiKey: keyStorage !== null,
    keyStorage,
    updatedAt: record.updatedAt
  };
}

function serializeProvider(record: StoredProvider): string {
  const serialized = `${JSON.stringify(storedProviderSchema.parse(record), null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PROVIDER_FILE_BYTES) throw new Error('La configuración del proveedor supera el límite de tamaño.');
  return serialized;
}

export interface ProviderStoreOptions {
  now?: () => Date;
}

export class ProviderStore {
  readonly providerPath: string;
  readonly #directory: string;
  readonly #safeStorage: SafeStorageAdapter;
  readonly #now: () => Date;
  #record: StoredProvider | null = null;
  #sessionApiKey: string | null = null;
  #warning: string | undefined;
  #initializing: Promise<ProviderStoreLoadResult> | null = null;
  #initialized = false;
  #write: Promise<void> = Promise.resolve();
  #disposed = false;

  constructor(userDataDirectory: string, safeStorage: SafeStorageAdapter, options: ProviderStoreOptions = {}) {
    this.#directory = userDataDirectory;
    this.providerPath = path.join(userDataDirectory, 'agent-provider.json');
    this.#safeStorage = safeStorage;
    this.#now = options.now ?? (() => new Date());
  }

  get lastWarning(): string | undefined {
    return this.#warning;
  }

  async initialize(): Promise<ProviderStoreLoadResult> {
    this.#assertActive();
    if (this.#initialized) return { provider: this.#public(), ...(this.#warning ? { warning: this.#warning } : {}) };
    if (this.#initializing) return this.#initializing;
    this.#initializing = this.#loadFromDisk();
    try {
      return await this.#initializing;
    } finally {
      this.#initializing = null;
    }
  }

  async #loadFromDisk(): Promise<ProviderStoreLoadResult> {
    const candidate = await readSecureText(this.providerPath, MAX_PROVIDER_FILE_BYTES);
    if (candidate.status === 'missing') {
      this.#initialized = true;
      return { provider: null };
    }
    let reason: string | undefined;
    if (candidate.status === 'invalid') {
      reason = candidate.reason;
    } else {
      try {
        const record = storedProviderSchema.parse(JSON.parse(candidate.source) as unknown);
        const normalizedBaseUrl = normalizeProviderBaseUrl(record.baseUrl);
        if (normalizedBaseUrl !== record.baseUrl) throw new Error('La URL base almacenada no está normalizada.');
        // The key is not decrypted here. Reading the keychain at launch would make macOS ask for the Mac's password on
        // every start of a newly signed build, and a denial is not a corrupt file: revealApiKey() reports it when needed.
        this.#record = record;
        this.#initialized = true;
        return { provider: this.#public() };
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
      }
    }

    let preservedPath: string | null = null;
    try {
      preservedPath = await preserveCorruptFile(this.providerPath, this.#now());
    } catch (error) {
      const preservationError = error instanceof Error ? error.message : String(error);
      this.#warning = `agent-provider.json no era válido (${reason}). No se pudo preservar todavía (${preservationError}).`;
    }
    if (!this.#warning) {
      this.#warning = `agent-provider.json no era válido (${reason}).${preservedPath ? ` Se conservó sin cambios como ${path.basename(preservedPath)}.` : ''}`;
    }
    this.#record = null;
    this.#initialized = true;
    return { provider: null, warning: this.#warning };
  }

  async save(input: AgentProviderInput, options: ProviderSaveOptions = {}): Promise<AgentProviderPublic> {
    this.#assertActive();
    const validated = validateAgentProviderInput(input);
    const rememberKey = options.rememberKey ?? true;
    let encryptedApiKey: string | undefined;
    // Only a remembered key touches the keychain; a session key never does, so it never makes macOS ask for a password.
    if (rememberKey) {
      if (!this.#safeStorage.isEncryptionAvailable()) throw new ProviderEncryptionUnavailableError();
      let encrypted: Buffer;
      try {
        encrypted = this.#safeStorage.encryptString(validated.apiKey);
      } catch {
        throw new ProviderEncryptionUnavailableError();
      }
      if (encrypted.length === 0) throw new ProviderEncryptionUnavailableError();
      encryptedApiKey = encrypted.toString('base64');
    }
    await this.initialize();
    const timestamp = this.#now().toISOString();
    const record = storedProviderSchema.parse({
      schemaVersion: PROVIDER_STORE_SCHEMA_VERSION,
      baseUrl: validated.baseUrl,
      model: validated.model,
      ...(encryptedApiKey ? { encryptedApiKey } : {}),
      createdAt: this.#record?.createdAt ?? timestamp,
      updatedAt: timestamp
    });
    const serialized = serializeProvider(record);
    await this.#enqueue(async () => {
      await writeSecureTextAtomically(this.#directory, this.providerPath, serialized);
    });
    this.#record = record;
    this.#sessionApiKey = rememberKey ? null : validated.apiKey;
    this.#warning = undefined;
    return toPublic(record, this.#sessionApiKey);
  }

  async getPublic(): Promise<AgentProviderPublic | null> {
    await this.initialize();
    return this.#public();
  }

  async revealApiKey(): Promise<string | null> {
    await this.initialize();
    if (!this.#record) return null;
    if (this.#sessionApiKey) return this.#sessionApiKey;
    if (!this.#record.encryptedApiKey) return null;
    if (!this.#safeStorage.isEncryptionAvailable()) throw new ProviderEncryptionUnavailableError();
    try {
      const plaintext = this.#safeStorage.decryptString(Buffer.from(this.#record.encryptedApiKey, 'base64'));
      if (plaintext.length === 0 || plaintext.length > MAX_PROVIDER_API_KEY_LENGTH) throw new Error('invalid plaintext');
      return plaintext;
    } catch {
      throw new ProviderDecryptionError();
    }
  }

  async clear(): Promise<boolean> {
    this.#assertActive();
    await this.initialize();
    const existed = this.#record !== null;
    await this.#enqueue(async () => {
      await unlink(this.providerPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    });
    this.#record = null;
    this.#sessionApiKey = null;
    this.#warning = undefined;
    return existed;
  }

  async flush(): Promise<void> {
    await this.#write;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    await this.flush();
    this.#record = null;
    this.#sessionApiKey = null;
    this.#disposed = true;
  }

  #public(): AgentProviderPublic | null {
    return this.#record ? toPublic(this.#record, this.#sessionApiKey) : null;
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const current = this.#write.catch(() => undefined).then(operation);
    this.#write = current;
    return current;
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('ProviderStore ya fue cerrado.');
  }
}
