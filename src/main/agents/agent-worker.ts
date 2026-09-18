import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { z } from 'zod';

const WORKER_PROTOCOL_VERSION = 1 as const;
const MAX_WORKER_LINE_BYTES = 512 * 1024;
const MAX_WORKER_STDERR_BYTES = 64 * 1024;
// A frozen sidecar imports Browser Use and its model clients before it answers; the first launch after installation
// also waits for macOS to verify every bundled library.
const READY_TIMEOUT_MS = 60_000;
const STOP_GRACE_MS = 5_000;
const KILL_GRACE_MS = 2_000;

const workerBaseSchema = z.object({ protocolVersion: z.literal(WORKER_PROTOCOL_VERSION), type: z.string() }).passthrough();
const workerRunBaseSchema = workerBaseSchema.extend({
  runId: z.string().uuid(),
  taskId: z.string().uuid(),
  browserId: z.string().uuid(),
  agentId: z.string().uuid(),
  runtimeEpoch: z.number().int().min(1),
  sequence: z.number().int().min(0)
}).passthrough();
const errorCodeSchema = z.string().max(200).regex(/^[a-z0-9-]+$/);

export const agentWorkerEventSchema = z.discriminatedUnion('type', [
  workerRunBaseSchema.extend({ type: z.literal('ready') }),
  workerRunBaseSchema.extend({ type: z.literal('state'), state: z.enum(['running', 'paused']) }),
  workerRunBaseSchema.extend({
    type: z.literal('action'),
    summary: z.string().max(20_000),
    step: z.number().int().min(0).max(1_000_000).optional(),
    actions: z.array(z.string().max(128)).max(10).optional()
  }),
  workerRunBaseSchema.extend({
    type: z.literal('result'),
    summary: z.string().max(50_000),
    outcome: z.enum(['success', 'cancelled', 'interrupted']).default('success')
  }),
  workerRunBaseSchema.extend({
    type: z.literal('error'),
    message: z.string().max(20_000),
    code: errorCodeSchema.optional(),
    diagnostic: z.string().max(20_000).optional(),
    fatal: z.boolean().optional()
  })
]);

// A worker that fails before it has accepted its start command (unsupported protocol, missing runtime, the E2E stub)
// cannot tag its error with a run identity.
const workerStartupErrorSchema = workerBaseSchema.extend({
  type: z.literal('error'),
  message: z.string().max(20_000),
  code: errorCodeSchema.optional()
}).passthrough();

export type AgentWorkerEvent = z.infer<typeof agentWorkerEventSchema>;

/** A startup failure with a stable code; the manager maps codes to user-facing messages. */
export class AgentWorkerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AgentWorkerError';
    this.code = code;
  }
}

export interface AgentWorkerStartConfig {
  runId: string;
  taskId: string;
  browserId: string;
  agentId: string;
  runtimeEpoch: number;
  instruction: string;
  progressSummary?: string;
  cdpUrl: string;
  model: {
    baseUrl: string;
    model: string;
    apiKey: string;
  };
}

export interface AgentWorkerOptions {
  onEvent: (event: AgentWorkerEvent) => void;
  onExit: (details: { code: number | null; signal: NodeJS.Signals | null; diagnostic: string }) => void;
  launch?: () => { command: string; args: string[] };
}

export interface AgentHostLaunchContext {
  packaged: boolean;
  resourcesPath: string;
  /** The repository root of a development run. */
  root: string;
  arch: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}

/** Finds the sidecar: an explicit override, the packaged resources, or a development build of the repository. */
export function resolveAgentHostLaunch(context: AgentHostLaunchContext): { command: string; args: string[] } {
  const override = context.env.OMNIBROWSER_AGENT_HOST_PATH;
  if (override) return { command: path.resolve(context.root, override), args: [] };
  const executableName = context.platform === 'win32' ? 'agent-host.exe' : 'agent-host';
  if (context.packaged) {
    // forge.config.cjs copies either the PyInstaller onedir bundle or, for E2E packages only, the test stub.
    const candidates = [
      path.join(context.resourcesPath, 'agent-host', executableName),
      path.join(context.resourcesPath, 'test-stub', executableName)
    ];
    const command = candidates.find((candidate) => fs.existsSync(candidate));
    if (!command) throw new AgentWorkerError('runtime-unavailable', 'El runtime de agentes no está incluido en esta instalación.');
    return { command, args: [] };
  }
  const runtimeDirectory = path.join(context.root, 'agent-runtime');
  const developmentBinary = path.join(runtimeDirectory, 'dist', context.arch, 'agent-host', executableName);
  if (fs.existsSync(developmentBinary)) return { command: developmentBinary, args: [] };
  // Without a frozen build the source runs on a Python that has requirements.lock installed: the configured one, or the
  // virtual environment agent:build creates. The system Python has no Browser Use.
  const buildPython = path.join(runtimeDirectory, `.venv-${context.arch}`, 'bin', 'python');
  const python = context.env.OMNIBROWSER_AGENT_PYTHON || (fs.existsSync(buildPython) ? buildPython : null);
  if (!python) throw new AgentWorkerError('runtime-not-built', 'El runtime de agentes no está construido.');
  return { command: python, args: [path.join(runtimeDirectory, 'agent_host.py')] };
}

function defaultLaunch(): { command: string; args: string[] } {
  return resolveAgentHostLaunch({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    root: process.cwd(),
    arch: process.arch,
    platform: process.platform,
    env: process.env
  });
}

function publicDiagnostic(stderr: string): string {
  const bytes = Buffer.byteLength(stderr, 'utf8');
  if (bytes === 0) return '';
  // stderr belongs to third-party Python code and may contain page text or provider-specific
  // credentials that no regex can identify reliably. Keep only a correlation fingerprint.
  const digest = createHash('sha256').update(stderr).digest('hex').slice(0, 16);
  return `stderr sha256:${digest} (${bytes} bytes captured)`;
}

export class AgentWorker {
  readonly #onEvent: AgentWorkerOptions['onEvent'];
  readonly #onExit: AgentWorkerOptions['onExit'];
  readonly #launch: () => { command: string; args: string[] };
  #child: ChildProcessWithoutNullStreams | null = null;
  #stdoutBuffer = '';
  #stderrBuffer = '';
  #readyResolve: (() => void) | null = null;
  #readyReject: ((error: Error) => void) | null = null;
  #readyTimer: NodeJS.Timeout | null = null;
  #stopTimer: NodeJS.Timeout | null = null;
  #killTimer: NodeJS.Timeout | null = null;
  #expected: AgentWorkerStartConfig | null = null;
  #tempRoot: string | null = null;
  #exited = false;

  constructor(options: AgentWorkerOptions) {
    this.#onEvent = options.onEvent;
    this.#onExit = options.onExit;
    this.#launch = options.launch ?? defaultLaunch;
  }

  get isRunning(): boolean {
    return this.#child !== null && !this.#exited;
  }

  async start(config: AgentWorkerStartConfig): Promise<void> {
    if (this.#child) throw new Error('El worker del agente ya fue iniciado.');
    this.#expected = config;
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'omnibrowser-agent-'));
    await chmod(tempRoot, 0o700);
    this.#tempRoot = tempRoot;
    let child: ChildProcessWithoutNullStreams;
    try {
      const launch = this.#launch();
      child = spawn(launch.command, launch.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          PATH: process.env.PATH,
          LANG: process.env.LANG,
          LC_ALL: process.env.LC_ALL,
          TMPDIR: tempRoot,
          TEMP: tempRoot,
          TMP: tempRoot,
          OMNIBROWSER_AGENT_TEMP_ROOT: tempRoot,
          PYTHONUNBUFFERED: '1',
          ANONYMIZED_TELEMETRY: 'false',
          BROWSER_USE_CLOUD_SYNC: 'false'
        }
      });
    } catch (error) {
      await this.#cleanupTempRoot();
      throw error;
    }
    this.#child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.#readStdout(chunk));
    child.stderr.on('data', (chunk: string) => {
      this.#stderrBuffer = `${this.#stderrBuffer}${chunk}`.slice(-MAX_WORKER_STDERR_BYTES);
    });
    // A write to a worker that already exited must not become an uncaught stream error in main.
    child.stdin.on('error', () => undefined);
    child.once('error', (error: NodeJS.ErrnoException) => {
      this.#failReady(new AgentWorkerError(error.code === 'ENOENT' || error.code === 'EACCES' ? 'runtime-unavailable' : 'runtime-start-failed', error.message));
      this.#handleExit(null, null);
    });
    // 'close' follows 'exit' once stdout has been drained, so the final result line is never lost to the exit handler.
    child.once('close', (code, signal) => this.#handleExit(code, signal));

    const ready = new Promise<void>((resolve, reject) => {
      this.#readyResolve = resolve;
      this.#readyReject = reject;
      this.#readyTimer = setTimeout(() => {
        this.#failReady(new AgentWorkerError('ready-timeout', 'El runtime de agentes no respondió a tiempo.'));
        this.terminate();
      }, READY_TIMEOUT_MS);
    });
    this.#send({
      type: 'start',
      protocolVersion: WORKER_PROTOCOL_VERSION,
      ...config
    });
    await ready;
  }

  pause(runId: string): void {
    this.#send({ type: 'pause', protocolVersion: WORKER_PROTOCOL_VERSION, runId });
  }

  resume(runId: string): void {
    this.#send({ type: 'resume', protocolVersion: WORKER_PROTOCOL_VERSION, runId });
  }

  stop(runId: string): void {
    if (!this.#child || this.#exited) return;
    this.#send({ type: 'stop', protocolVersion: WORKER_PROTOCOL_VERSION, runId });
    this.#scheduleKill();
  }

  /** Releases a worker whose run already finished: EOF ends its control loop, and a stuck process is killed later. */
  dispose(): void {
    if (!this.#child || this.#exited) return;
    if (!this.#child.stdin.destroyed) this.#child.stdin.end();
    this.#scheduleKill();
  }

  terminate(): void {
    if (!this.#child || this.#exited) return;
    this.#child.kill('SIGTERM');
    this.#killTimer ??= setTimeout(() => {
      if (!this.#child || this.#exited) return;
      this.#child.kill('SIGKILL');
    }, KILL_GRACE_MS);
  }

  #scheduleKill(): void {
    this.#stopTimer ??= setTimeout(() => {
      if (!this.#child || this.#exited) return;
      this.#child.kill('SIGTERM');
      this.#killTimer ??= setTimeout(() => {
        if (!this.#child || this.#exited) return;
        this.#child.kill('SIGKILL');
      }, KILL_GRACE_MS);
    }, STOP_GRACE_MS);
  }

  #send(payload: object): void {
    const child = this.#child;
    if (!child || this.#exited || child.stdin.destroyed || child.stdin.writableEnded) return;
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  #readStdout(chunk: string): void {
    this.#stdoutBuffer += chunk;
    if (Buffer.byteLength(this.#stdoutBuffer) > MAX_WORKER_LINE_BYTES * 2) {
      this.terminate();
      return;
    }
    let newline = this.#stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.#stdoutBuffer.slice(0, newline).trim();
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      if (line) this.#handleLine(line);
      newline = this.#stdoutBuffer.indexOf('\n');
    }
  }

  #handleLine(line: string): void {
    if (Buffer.byteLength(line) > MAX_WORKER_LINE_BYTES) {
      this.terminate();
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.terminate();
      return;
    }
    const parsed = agentWorkerEventSchema.safeParse(value);
    if (!parsed.success) {
      const startup = workerStartupErrorSchema.safeParse(value);
      if (startup.success && this.#readyReject) {
        this.#failReady(new AgentWorkerError(startup.data.code ?? 'runtime-start-failed', startup.data.message));
      }
      this.terminate();
      return;
    }
    const event = parsed.data;
    if (event.type === 'ready') {
      const expected = this.#expected;
      if (!expected || event.runId !== expected.runId || event.taskId !== expected.taskId
        || event.browserId !== expected.browserId || event.agentId !== expected.agentId
        || event.runtimeEpoch !== expected.runtimeEpoch) {
        this.#failReady(new AgentWorkerError('identity-mismatch', 'El runtime respondió con una identidad de sesión inválida.'));
        this.terminate();
        return;
      }
      this.#resolveReady();
      return;
    }
    this.#onEvent(event);
  }

  #resolveReady(): void {
    if (this.#readyTimer) clearTimeout(this.#readyTimer);
    this.#readyTimer = null;
    const resolve = this.#readyResolve;
    this.#readyResolve = null;
    this.#readyReject = null;
    resolve?.();
  }

  #failReady(error: Error): void {
    if (this.#readyTimer) clearTimeout(this.#readyTimer);
    this.#readyTimer = null;
    const reject = this.#readyReject;
    this.#readyResolve = null;
    this.#readyReject = null;
    reject?.(error);
  }

  #handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#exited) return;
    this.#exited = true;
    if (this.#readyTimer) clearTimeout(this.#readyTimer);
    if (this.#stopTimer) clearTimeout(this.#stopTimer);
    if (this.#killTimer) clearTimeout(this.#killTimer);
    this.#failReady(new AgentWorkerError('runtime-exited', 'El runtime de agentes terminó antes de inicializarse.'));
    const diagnostic = publicDiagnostic(this.#stderrBuffer);
    this.#stderrBuffer = '';
    void this.#cleanupTempRoot().finally(() => this.#onExit({ code, signal, diagnostic }));
  }

  async #cleanupTempRoot(): Promise<void> {
    const tempRoot = this.#tempRoot;
    this.#tempRoot = null;
    if (!tempRoot) return;
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
