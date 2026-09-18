import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentManager } from '../../src/main/agents/agent-manager';
import { AgentStore, type AgentBrowserDescriptor } from '../../src/main/agents/agent-store';
import { ProviderStore, type SafeStorageAdapter } from '../../src/main/agents/provider-store';
import { AgentWorkerError, type AgentWorkerEvent, type AgentWorkerOptions, type AgentWorkerStartConfig } from '../../src/main/agents/agent-worker';
import type { AgentSummary } from '../../src/shared/schemas';
import type { ScopedCdpGatewayOptions } from '../../src/main/agents/scoped-cdp-gateway';
import type { AutomationTarget } from '../../src/main/browser/browser-runtime';

const safeStorage: SafeStorageAdapter = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value, 'utf8'),
  decryptString: (value) => value.toString('utf8')
};

/** A login keychain the person refused when macOS asked for the Mac's password; counts every access. */
class RefusedKeychain implements SafeStorageAdapter {
  calls = 0;
  isEncryptionAvailable(): boolean { this.calls += 1; return false; }
  encryptString(): Buffer { this.calls += 1; throw new Error('Encryption is not available.'); }
  decryptString(): string { this.calls += 1; throw new Error('Decryption is not available.'); }
}

class FakeWorker {
  readonly options: AgentWorkerOptions;
  readonly deferStart: boolean;
  config: AgentWorkerStartConfig | null = null;
  paused: string[] = [];
  resumed: string[] = [];
  stopped: string[] = [];
  terminated = false;
  disposed = false;
  #resolveStart: (() => void) | null = null;
  #rejectStart: ((error: Error) => void) | null = null;

  constructor(options: AgentWorkerOptions, deferStart = false) {
    this.options = options;
    this.deferStart = deferStart;
  }

  async start(config: AgentWorkerStartConfig): Promise<void> {
    this.config = config;
    if (this.deferStart) {
      await new Promise<void>((resolve, reject) => {
        this.#resolveStart = resolve;
        this.#rejectStart = reject;
      });
    }
  }
  pause(runId: string): void { this.paused.push(runId); }
  resume(runId: string): void { this.resumed.push(runId); }
  stop(runId: string): void { this.stopped.push(runId); }
  dispose(): void { this.disposed = true; }
  terminate(): void { this.terminated = true; }
  failStart(error: Error): void { this.#rejectStart?.(error); }
  emit(event: AgentWorkerEvent): void { this.options.onEvent(event); }
  finishStart(): void { this.#resolveStart?.(); }
}

function targetFor(descriptor: AgentBrowserDescriptor, runtimeEpoch = 1): AutomationTarget {
  return {
    browserId: descriptor.browserId,
    profileId: descriptor.profileId,
    contentsId: runtimeEpoch,
    targetId: `target-${descriptor.browserId}-${runtimeEpoch}`,
    runtimeEpoch,
    contents: { isDestroyed: () => false } as unknown as AutomationTarget['contents']
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for agent state.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('AgentManager', () => {
  const directories: string[] = [];
  const managers: AgentManager[] = [];

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  function eventFor(config: AgentWorkerStartConfig, sequence: number) {
    return {
      protocolVersion: 1 as const,
      runId: config.runId,
      taskId: config.taskId,
      browserId: config.browserId,
      agentId: config.agentId,
      runtimeEpoch: config.runtimeEpoch,
      sequence
    };
  }

  async function setup(
    count: number,
    maxActiveAgents = 4,
    setupOptions: {
      deferWorkerStart?: boolean;
      fetchImpl?: typeof fetch;
      withoutProvider?: boolean;
      /** The keychain of this run; the provider of a previous run is always saved with a working one. */
      safeStorage?: SafeStorageAdapter;
      /** userData of a previous run, to restart on it. */
      directory?: string;
      descriptors?: AgentBrowserDescriptor[];
    } = {}
  ) {
    const directory = setupOptions.directory ?? await mkdtemp(path.join(os.tmpdir(), 'omnibrowser-agent-manager-'));
    if (!setupOptions.directory) directories.push(directory);
    const profileId = randomUUID();
    const descriptors = setupOptions.descriptors ?? Array.from({ length: count }, () => ({
      browserId: randomUUID(),
      profileId,
      persistenceKind: 'persistent' as const
    }));
    const targets = new Map<string, AutomationTarget>(descriptors.map((descriptor) => [descriptor.browserId, targetFor(descriptor)]));
    const workers: FakeWorker[] = [];
    const gatewayTargets: AutomationTarget[] = [];
    const states: AgentSummary[] = [];
    const notices: string[] = [];
    if (!setupOptions.withoutProvider && !setupOptions.directory) {
      await new ProviderStore(directory, safeStorage).save({ baseUrl: 'https://provider.example/v1', model: 'test-model', apiKey: 'secret-value' });
    }
    const providerStore = new ProviderStore(directory, setupOptions.safeStorage ?? safeStorage);
    const manager = new AgentManager({
      store: new AgentStore(directory),
      providerStore,
      listBrowserDescriptors: () => descriptors,
      getBrowserDescriptor: (browserId) => descriptors.find((descriptor) => descriptor.browserId === browserId) ?? null,
      acquireTarget: (browserId) => {
        const target = targets.get(browserId);
        if (!target) throw new Error('missing target');
        return target;
      },
      emitState: (summary) => { states.push(summary); },
      emitEvent: () => undefined,
      onNotice: (_level, message) => { notices.push(message); },
      createGateway: (options: ScopedCdpGatewayOptions) => {
        gatewayTargets.push(options.target);
        return {
          runtimeEpoch: options.target.runtimeEpoch,
          start: async () => `http://127.0.0.1:1234/cdp/${options.target.browserId}`,
          stop: async () => undefined
        };
      },
      createWorker: (workerOptions) => {
        const worker = new FakeWorker(workerOptions, setupOptions.deferWorkerStart ?? false);
        workers.push(worker);
        return worker;
      },
      ...(setupOptions.fetchImpl ? { fetchImpl: setupOptions.fetchImpl } : {}),
      maxActiveAgents
    });
    managers.push(manager);
    await manager.initialize();
    return { manager, descriptors, targets, workers, gatewayTargets, states, notices, directory };
  }

  it('caps global concurrency and rejects cross-browser or stale worker events', async () => {
    const { manager, descriptors, workers, gatewayTargets } = await setup(5);
    for (const [index, descriptor] of descriptors.entries()) {
      await manager.send(descriptor.browserId, `task-${index}`);
    }
    await waitFor(() => workers.length === 4 && workers.every((worker) => worker.config !== null));
    expect(new Set(gatewayTargets.map((target) => target.browserId)).size).toBe(4);

    const first = workers[0];
    const config = first?.config;
    expect(config).not.toBeNull();
    if (!first || !config) return;
    first.emit({
      protocolVersion: 1,
      type: 'action',
      runId: config.runId,
      taskId: config.taskId,
      browserId: descriptors[1]!.browserId,
      agentId: config.agentId,
      runtimeEpoch: config.runtimeEpoch,
      sequence: 1,
      summary: 'must be ignored'
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await manager.get(config.browserId)).timeline.some((event) => event.summary === 'must be ignored')).toBe(false);

    first.emit({
      protocolVersion: 1,
      type: 'result',
      runId: config.runId,
      taskId: config.taskId,
      browserId: config.browserId,
      agentId: config.agentId,
      runtimeEpoch: config.runtimeEpoch,
      sequence: 2,
      summary: 'done in the assigned browser',
      outcome: 'success'
    });
    await waitFor(() => workers.length === 5 && Boolean(workers[4]?.config));
    expect((await manager.get(config.browserId)).messages.at(-1)?.content).toBe('done in the assigned browser');
    expect(workers[4]?.config?.browserId).toBe(descriptors[4]?.browserId);
  });

  it('pauses at worker boundaries and Stop cancels the active task plus its private queue', async () => {
    const { manager, descriptors, workers } = await setup(1);
    const browserId = descriptors[0]!.browserId;
    await manager.send(browserId, 'first');
    await waitFor(() => Boolean(workers[0]?.config));
    await manager.send(browserId, 'second');
    await manager.pause(browserId);
    const worker = workers[0]!;
    const config = worker.config!;
    expect(worker.paused).toEqual([config.runId]);
    worker.emit({
      protocolVersion: 1,
      type: 'state',
      runId: config.runId,
      taskId: config.taskId,
      browserId,
      agentId: config.agentId,
      runtimeEpoch: config.runtimeEpoch,
      sequence: 1,
      state: 'paused'
    });
    await waitFor(async () => (await manager.get(browserId)).summary.state === 'paused');
    const stopped = await manager.stop(browserId);
    expect(worker.stopped).toEqual([config.runId]);
    expect(stopped.summary.state).toBe('completed');
    expect(stopped.summary.queuedTaskCount).toBe(0);
    expect(stopped.tasks.map((task) => task.outcome)).toEqual(['cancelled', 'cancelled']);
  });

  it('keeps Pause and Stop responsive while the Python worker is still starting', async () => {
    const { manager, descriptors, workers } = await setup(1, 4, { deferWorkerStart: true });
    const browserId = descriptors[0]!.browserId;
    await manager.send(browserId, 'wait for the runtime import');
    await waitFor(() => Boolean(workers[0]?.config));

    const paused = await manager.pause(browserId);
    const worker = workers[0]!;
    const runId = worker.config!.runId;
    expect(paused.summary.state).toBe('running');
    expect(worker.paused).toEqual([runId]);

    const stopped = await manager.stop(browserId);
    expect(worker.stopped).toEqual([runId]);
    expect(stopped.summary.state).toBe('completed');
    expect(stopped.tasks[0]?.outcome).toBe('cancelled');
    worker.finishStart();
  });

  it('tests the structured response contract used by Browser Use', async () => {
    let choice: Record<string, unknown> = { message: { content: '{"ok":true}' }, finish_reason: 'stop' };
    let requestBody: Record<string, unknown> | null = null;
    const fetchImpl = (async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1]
    ) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [choice] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }) as typeof fetch;
    const { manager } = await setup(1, 4, { fetchImpl });
    const input = { baseUrl: 'https://provider.example/v1', model: 'test-model' };

    await expect(manager.testProvider(input)).resolves.toMatchObject({ ok: true });
    // The same output budget Browser Use gives every step: a reasoning model spends part of it before answering.
    expect(requestBody).toMatchObject({
      max_completion_tokens: 4096,
      response_format: { type: 'json_schema' }
    });
    // Reasoning models reject sampling parameters; the check must not fail for a provider Browser Use supports.
    expect(requestBody).not.toHaveProperty('temperature');

    // A reasoning model answers next to its reasoning, which is ignored.
    choice = { message: { content: '{\n  "ok": true\n}', reasoning_content: 'The user wants JSON.' }, finish_reason: 'stop' };
    await expect(manager.testProvider(input)).resolves.toMatchObject({ ok: true });

    choice = { message: { content: 'not-json' }, finish_reason: 'stop' };
    await expect(manager.testProvider(input)).rejects.toThrow(/respuesta JSON estructurada/);

    // A reasoning model that spends the whole budget thinking: Browser Use would reject every step the same way.
    choice = { message: { content: '', reasoning: 'The user asks for a JSON object…' }, finish_reason: 'length' };
    await expect(manager.testProvider(input)).rejects.toThrow('El modelo agotó los 4096 tokens de salida antes de terminar su respuesta');
    choice = { message: { content: '{"ok":', reasoning: '' }, finish_reason: 'length' };
    await expect(manager.testProvider(input)).rejects.toThrow(/agotó los 4096 tokens/);

    choice = { message: { content: null, reasoning_content: 'Thinking about the answer.' }, finish_reason: 'stop' };
    await expect(manager.testProvider(input)).rejects.toThrow('El modelo devolvió solo su razonamiento, sin la respuesta JSON que necesita Browser Use.');
  });

  it('restores an in-flight task as explicitly paused after a restart', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'omnibrowser-agent-restart-'));
    directories.push(directory);
    const descriptor = { browserId: randomUUID(), profileId: randomUUID(), persistenceKind: 'persistent' as const };
    const store = new AgentStore(directory);
    const record = await store.ensure(descriptor);
    const taskId = randomUUID();
    record.tasks.push({
      id: taskId,
      instruction: 'continue me',
      state: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: null,
      outcome: null
    });
    record.state = 'running';
    record.activeTaskId = taskId;
    await store.save(record);
    await store.dispose();

    const manager = new AgentManager({
      store: new AgentStore(directory),
      providerStore: new ProviderStore(directory, safeStorage),
      listBrowserDescriptors: () => [descriptor],
      getBrowserDescriptor: () => descriptor,
      acquireTarget: () => targetFor(descriptor),
      emitState: () => undefined,
      emitEvent: () => undefined
    });
    managers.push(manager);
    await manager.initialize();
    const snapshot = await manager.get(descriptor.browserId);
    expect(snapshot.summary.state).toBe('paused');
    expect(snapshot.tasks[0]?.state).toBe('paused');
    expect(snapshot.tasks[0]?.outcome).toBe('interrupted');
    expect(snapshot.timeline.at(-1)?.summary).toContain('interrumpida por reinicio');
  });

  it('creates agent records only when a card is used, so a large workspace writes nothing at startup', async () => {
    const { manager, descriptors, directory } = await setup(3);
    const files = async () => readdir(path.join(directory, 'agents')).catch(() => [] as string[]);
    expect(await manager.list()).toEqual([]);
    const browserId = descriptors[0]!.browserId;
    const opened = await manager.get(browserId);
    expect(opened.summary.state).toBe('idle');
    expect(await files()).toEqual([]);
    await manager.send(browserId, 'now persist me');
    expect(await files()).toEqual([`${browserId}.json`]);
    expect((await manager.list()).map((summary) => summary.browserId)).toEqual([browserId]);
  });

  it('keeps OmniBrowser usable when the agent store cannot be opened', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'omnibrowser-agent-unavailable-'));
    directories.push(directory);
    await writeFile(path.join(directory, 'agents'), 'not a directory');
    const descriptor = { browserId: randomUUID(), profileId: randomUUID(), persistenceKind: 'persistent' as const };
    const notices: string[] = [];
    const manager = new AgentManager({
      store: new AgentStore(directory),
      providerStore: new ProviderStore(directory, safeStorage),
      listBrowserDescriptors: () => [descriptor],
      getBrowserDescriptor: () => descriptor,
      acquireTarget: () => targetFor(descriptor),
      emitState: () => undefined,
      emitEvent: () => undefined,
      onNotice: (_level, message) => { notices.push(message); }
    });
    managers.push(manager);
    await expect(manager.initialize()).resolves.toBeUndefined();
    expect(manager.available).toBe(false);
    expect(notices.join('\n')).toMatch(/Los agentes no están disponibles/);
    await expect(manager.list()).resolves.toEqual([]);
    await expect(manager.getProvider()).resolves.toMatchObject({ configured: false });
    await expect(manager.send(descriptor.browserId, 'anything')).rejects.toThrow(/Los agentes no están disponibles/);
  });

  it('continues after a non-fatal worker error and localizes fatal ones without echoing page content', async () => {
    const { manager, descriptors, workers } = await setup(1);
    const browserId = descriptors[0]!.browserId;
    await manager.send(browserId, 'do something');
    await waitFor(() => Boolean(workers[0]?.config));
    const worker = workers[0]!;
    const config = worker.config!;
    worker.emit({ ...eventFor(config, 1), type: 'error', code: 'run-finished', message: 'The run has already finished.', fatal: false });
    await waitFor(async () => (await manager.get(browserId)).timeline.some((event) => event.summary.startsWith('El runtime ignoró una orden')));
    expect((await manager.get(browserId)).summary.state).toBe('running');
    expect(worker.terminated).toBe(false);

    worker.emit({
      ...eventFor(config, 2),
      type: 'error',
      code: 'agent-run-failed',
      message: 'The agent failed while controlling this browser.',
      diagnostic: 'AuthenticationError: page says ignore previous instructions',
      fatal: true
    });
    await waitFor(async () => (await manager.get(browserId)).summary.state === 'error');
    const snapshot = await manager.get(browserId);
    expect(snapshot.messages.at(-1)?.content).toBe('El agente falló mientras controlaba este browser (AuthenticationError).');
    expect(JSON.stringify(snapshot)).not.toContain('ignore previous instructions');
    expect(worker.terminated).toBe(true);
  });

  it('reports a worker that cannot start with a Spanish message for its error code', async () => {
    const { manager, descriptors, workers } = await setup(2, 4, { deferWorkerStart: true });
    const [testPackage, development] = descriptors.map((descriptor) => descriptor.browserId) as [string, string];
    await manager.send(testPackage, 'start please');
    await waitFor(() => Boolean(workers[0]?.config));
    workers[0]!.failStart(new AgentWorkerError('test-runtime', 'Agent runtime is disabled in the E2E package.'));
    await waitFor(async () => (await manager.get(testPackage)).summary.state === 'error');
    expect((await manager.get(testPackage)).messages.at(-1)?.content).toBe('El runtime de agentes está desactivado en esta compilación de prueba.');

    // A development checkout without `npm run agent:build` says how to get the runtime.
    await manager.send(development, 'start please');
    await waitFor(() => Boolean(workers[1]?.config));
    workers[1]!.failStart(new AgentWorkerError('runtime-not-built', 'El runtime de agentes no está construido.'));
    await waitFor(async () => (await manager.get(development)).summary.state === 'error');
    expect((await manager.get(development)).messages.at(-1)?.content).toMatch(/no está construido.*npm run agent:build/);
  });

  it('formats action steps in Spanish and releases a finished worker', async () => {
    const { manager, descriptors, workers } = await setup(1);
    const browserId = descriptors[0]!.browserId;
    await manager.send(browserId, 'fill the form');
    await waitFor(() => Boolean(workers[0]?.config));
    const worker = workers[0]!;
    const config = worker.config!;
    worker.emit({ ...eventFor(config, 1), type: 'action', summary: 'Actions: click, input', step: 2, actions: ['click', 'input'] });
    worker.emit({ ...eventFor(config, 2), type: 'result', summary: '', outcome: 'success' });
    await waitFor(async () => (await manager.get(browserId)).summary.state === 'completed');
    const snapshot = await manager.get(browserId);
    expect(snapshot.timeline.map((event) => event.summary)).toContain('Paso 2: clic, escribir');
    expect(snapshot.messages.at(-1)?.content).toBe('Tarea completada.');
    expect(worker.disposed).toBe(true);
  });

  it('bounds the private queue of a browser', async () => {
    const { manager, descriptors, workers } = await setup(1, 4, { deferWorkerStart: true });
    const browserId = descriptors[0]!.browserId;
    await manager.send(browserId, 'keeps the worker busy');
    await waitFor(() => Boolean(workers[0]?.config));
    for (let index = 0; index < 20; index += 1) await manager.send(browserId, `task ${index}`);
    expect((await manager.get(browserId)).summary.queuedTaskCount).toBe(20);
    await expect(manager.send(browserId, 'one too many')).rejects.toThrow(/ya tiene 20 instrucciones/);
    workers[0]!.finishStart();
  });

  it('gives a follow-up task the earlier conversation and a resumed task its interrupted progress', async () => {
    const { manager, descriptors, workers } = await setup(1);
    const browserId = descriptors[0]!.browserId;
    await manager.send(browserId, 'search for OmniBrowser');
    await waitFor(() => Boolean(workers[0]?.config));
    const first = workers[0]!;
    expect(first.config?.progressSummary).toBeUndefined();
    first.emit({ ...eventFor(first.config!, 1), type: 'result', summary: 'Found three results.', outcome: 'success' });
    await waitFor(async () => (await manager.get(browserId)).summary.state === 'completed');

    await manager.send(browserId, 'open the second result');
    await waitFor(() => Boolean(workers[1]?.config));
    const second = workers[1]!;
    expect(second.config?.progressSummary).toContain('User: search for OmniBrowser');
    expect(second.config?.progressSummary).toContain('Agent: Found three results.');
    expect(second.config?.progressSummary).not.toContain('open the second result');

    second.emit({ ...eventFor(second.config!, 1), type: 'action', summary: 'Actions: click', step: 1, actions: ['click'] });
    await waitFor(async () => (await manager.get(browserId)).timeline.some((event) => event.summary === 'Paso 1: clic'));
    await manager.prepareTargetRevocation(browserId, 'suspended');
    const paused = await manager.get(browserId);
    expect(paused.summary.state).toBe('paused');
    expect(paused.tasks.at(-1)?.outcome).toBe('interrupted');
    expect(paused.tasks.every((task) => !('progressSummary' in task))).toBe(true);

    await manager.resume(browserId);
    await waitFor(() => Boolean(workers[2]?.config));
    expect(workers[2]?.config?.taskId).toBe(second.config?.taskId);
    expect(workers[2]?.config?.progressSummary).toContain('interrupted after these steps');
    expect(workers[2]?.config?.progressSummary).toContain('Paso 1: clic');
  });

  it('never starts queued work while shutting down', async () => {
    const { manager, descriptors, workers } = await setup(2, 1);
    await manager.send(descriptors[0]!.browserId, 'first');
    await waitFor(() => Boolean(workers[0]?.config));
    await manager.send(descriptors[1]!.browserId, 'waits for capacity');
    await manager.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(workers).toHaveLength(1);
    expect(workers[0]!.terminated).toBe(true);
    await expect(manager.send(descriptors[1]!.browserId, 'late')).rejects.toThrow(/se está cerrando/);
  });

  it('starts a new agent identity when the browser changes profile', async () => {
    const { manager, descriptors, states } = await setup(1);
    const browserId = descriptors[0]!.browserId;
    const before = await manager.send(browserId, 'belongs to the first profile');
    expect(manager.hasConversation(browserId)).toBe(true);
    const nextProfile = randomUUID();
    descriptors[0] = { ...descriptors[0]!, profileId: nextProfile };
    await manager.resetForProfile(browserId, descriptors[0]!);
    const reset = states.at(-1)!;
    expect(reset.browserId).toBe(browserId);
    expect(reset.agentId).not.toBe(before.summary.agentId);
    expect(reset.sequence).toBe(0);
    const snapshot = await manager.get(browserId);
    expect(snapshot.messages).toEqual([]);
    expect(manager.hasConversation(browserId)).toBe(false);
  });

  it('never sends the stored key to a different provider origin and explains provider failures', async () => {
    const calls: string[] = [];
    let mode: 'unauthorized' | 'offline' = 'unauthorized';
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      calls.push(String(input));
      if (mode === 'offline') throw new TypeError('fetch failed');
      return new Response(JSON.stringify({ error: { message: 'Incorrect API key provided: secret-value' } }), { status: 401 });
    }) as typeof fetch;
    const { manager } = await setup(1, 4, { fetchImpl });

    await expect(manager.testProvider({ baseUrl: 'https://attacker.example/v1', model: 'test-model' })).rejects.toThrow(/clave API de nuevo/);
    await expect(manager.saveProvider({ baseUrl: 'https://attacker.example/v1', model: 'test-model' })).rejects.toThrow(/clave API de nuevo/);
    expect(calls).toEqual([]);

    const unauthorized = manager.testProvider({ baseUrl: 'https://provider.example/v1', model: 'test-model' });
    await expect(unauthorized).rejects.toThrow('El proveedor rechazó la prueba (HTTP 401: Incorrect API key provided: [REDACTED]).');
    mode = 'offline';
    await expect(manager.testProvider({ baseUrl: 'https://provider.example/v1', model: 'test-model' })).rejects.toThrow(/No se pudo conectar con el proveedor/);
    expect(calls).toEqual(['https://provider.example/v1/chat/completions', 'https://provider.example/v1/chat/completions']);
  });

  it('never reads the keychain at launch and asks for the key again when macOS refuses it', async () => {
    const keychain = new RefusedKeychain();
    const { manager, descriptors, workers, states } = await setup(1, 4, { safeStorage: keychain });
    const browserId = descriptors[0]!.browserId;
    // Launching with a saved provider must not make macOS ask for the Mac's password.
    expect(await manager.getProvider()).toMatchObject({ configured: true, hasApiKey: true, keyStorage: 'encrypted' });
    expect(keychain.calls).toBe(0);

    await manager.send(browserId, 'open the report');
    await waitFor(async () => (await manager.get(browserId)).summary.state === 'error');
    expect((await manager.get(browserId)).messages.at(-1)?.content).toMatch(/^macOS no permitió usar la clave guardada en el llavero\. Escríbela de nuevo/);
    // No worker was started, so the refused key never left main.
    expect(workers.every((worker) => worker.config === null)).toBe(true);
    // The cards ask for a provider instead of failing every queued task with the same error.
    expect(await manager.getProvider()).toMatchObject({ configured: false, hasApiKey: false, keyStorage: null, baseUrl: 'https://provider.example/v1' });
    expect(states.at(-1)?.requiresProvider).toBe(true);
    await expect(manager.testProvider({ baseUrl: 'https://provider.example/v1', model: 'test-model' })).rejects.toThrow(/Escríbela de nuevo/);

    // Typing the key again works for the rest of the session even though the keychain still refuses.
    const saved = await manager.saveProvider({ baseUrl: 'https://provider.example/v1', model: 'test-model', apiKey: 'typed-again' });
    expect(saved).toEqual({ configured: true, baseUrl: 'https://provider.example/v1', model: 'test-model', hasApiKey: true, keyStorage: 'session' });
    await manager.send(browserId, 'try again');
    await waitFor(() => workers.some((worker) => worker.config !== null));
    expect(workers.find((worker) => worker.config !== null)!.config!.model.apiKey).toBe('typed-again');
  });

  it('keeps a key for the session only without touching the keychain, and remembers the endpoint', async () => {
    const keychain = new RefusedKeychain();
    const first = await setup(1, 4, { safeStorage: keychain, withoutProvider: true });
    const saved = await first.manager.saveProvider({ baseUrl: 'https://provider.example/v1/', model: 'session-model', apiKey: 'session-key', rememberKey: false });
    expect(saved).toMatchObject({ configured: true, hasApiKey: true, keyStorage: 'session' });
    expect(keychain.calls).toBe(0);
    const stored = await readdir(first.directory);
    expect(stored).toContain('agent-provider.json');
    const source = await readFile(path.join(first.directory, 'agent-provider.json'), 'utf8');
    expect(source).toContain('session-model');
    expect(source).not.toContain('session-key');
    expect(source).not.toContain('encryptedApiKey');
    await first.manager.shutdown();

    // After a restart the endpoint and the model are still there; only the key is asked again.
    const second = await setup(1, 4, { directory: first.directory, descriptors: first.descriptors, safeStorage });
    expect(await second.manager.getProvider()).toEqual({ configured: false, baseUrl: 'https://provider.example/v1', model: 'session-model', hasApiKey: false, keyStorage: null });
    await expect(second.manager.send(first.descriptors[0]!.browserId, 'hello')).rejects.toThrow(/Configura y prueba un proveedor/);
  });
});
