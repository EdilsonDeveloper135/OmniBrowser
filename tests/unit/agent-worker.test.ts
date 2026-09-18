import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentWorker,
  AgentWorkerError,
  resolveAgentHostLaunch,
  type AgentHostLaunchContext,
  type AgentWorkerEvent,
  type AgentWorkerStartConfig
} from '../../src/main/agents/agent-worker';

function startConfig(overrides: Partial<AgentWorkerStartConfig> = {}): AgentWorkerStartConfig {
  return {
    runId: randomUUID(),
    taskId: randomUUID(),
    browserId: randomUUID(),
    agentId: randomUUID(),
    runtimeEpoch: 1,
    instruction: 'inspect the current page',
    cdpUrl: 'http://127.0.0.1:1234/cdp/capability',
    model: { baseUrl: 'https://provider.example/v1', model: 'model', apiKey: 'secret' },
    ...overrides
  };
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the worker.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('AgentWorker JSONL handshake', () => {
  it('sends start before waiting for ready and accepts a bound terminal event', async () => {
    const ids = {
      runId: randomUUID(),
      taskId: randomUUID(),
      browserId: randomUUID(),
      agentId: randomUUID()
    };
    const script = `
      let buffer = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf('\\n');
        if (newline < 0) return;
        const command = JSON.parse(buffer.slice(0, newline));
        process.stdout.write(JSON.stringify({
          protocolVersion: 1,
          type: 'ready',
          runId: command.runId,
          taskId: command.taskId,
          browserId: command.browserId,
          agentId: command.agentId,
          runtimeEpoch: command.runtimeEpoch,
          sequence: 1
        }) + '\\n');
        process.stdout.write(JSON.stringify({
          protocolVersion: 1,
          type: 'result',
          runId: command.runId,
          taskId: command.taskId,
          browserId: command.browserId,
          agentId: command.agentId,
          runtimeEpoch: command.runtimeEpoch,
          sequence: 2,
          summary: 'ok',
          outcome: 'success'
        }) + '\\n');
        process.stdin.destroy();
      });
    `;
    const events: AgentWorkerEvent[] = [];
    const worker = new AgentWorker({
      onEvent: (event) => events.push(event),
      onExit: () => undefined,
      launch: () => ({ command: process.execPath, args: ['-e', script] })
    });
    await worker.start({
      ...ids,
      runtimeEpoch: 3,
      instruction: 'do one thing',
      cdpUrl: 'http://127.0.0.1:1234/cdp/capability',
      model: { baseUrl: 'https://provider.example/v1', model: 'model', apiKey: 'secret' }
    });
    const deadline = Date.now() + 2_000;
    while (events.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'result', ...ids, runtimeEpoch: 3, summary: 'ok' });
  });

  it('never exposes raw third-party stderr in exit diagnostics', async () => {
    const secret = 'provider-secret-with-an-unusual-format';
    const pageText = 'private text copied from a password field';
    const exits: Array<{ code: number | null; signal: NodeJS.Signals | null; diagnostic: string }> = [];
    const script = `process.stderr.write(${JSON.stringify(`${secret}\n${pageText}`)});`;
    const worker = new AgentWorker({
      onEvent: () => undefined,
      onExit: (details) => exits.push(details),
      launch: () => ({ command: process.execPath, args: ['-e', script] })
    });
    const start = worker.start({
      runId: randomUUID(),
      taskId: randomUUID(),
      browserId: randomUUID(),
      agentId: randomUUID(),
      runtimeEpoch: 1,
      instruction: 'inspect the current page',
      cdpUrl: 'http://127.0.0.1:1234/cdp/capability',
      model: { baseUrl: 'https://provider.example/v1', model: 'model', apiKey: secret }
    });
    await expect(start).rejects.toThrow(/terminó antes de inicializarse/);
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 2_000;
      const poll = () => {
        if (exits.length > 0) resolve();
        else if (Date.now() > deadline) reject(new Error('Timed out waiting for worker exit.'));
        else setTimeout(poll, 5);
      };
      poll();
    });
    expect(exits[0]?.diagnostic).toMatch(/^stderr sha256:[a-f0-9]{16} \(\d+ bytes captured\)$/);
    expect(exits[0]?.diagnostic).not.toContain(secret);
    expect(exits[0]?.diagnostic).not.toContain(pageText);
  });

  it('turns an error emitted before the run identity exists into a coded startup failure', async () => {
    // The same line the E2E test stub prints: no run identity, a stable code, then exit 1.
    const line = JSON.stringify({ protocolVersion: 1, type: 'error', sequence: 1, code: 'test-runtime', message: 'Agent runtime is disabled in the E2E package.', fatal: true });
    const worker = new AgentWorker({
      onEvent: () => undefined,
      onExit: () => undefined,
      launch: () => ({ command: process.execPath, args: ['-e', `process.stdout.write(${JSON.stringify(`${line}\n`)}); process.exitCode = 1;`] })
    });
    const failure = await worker.start(startConfig()).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(AgentWorkerError);
    expect((failure as AgentWorkerError).code).toBe('test-runtime');
  });

  it('delivers the final result before reporting that the worker exited', async () => {
    const order: string[] = [];
    const script = `
      process.stdin.setEncoding('utf8');
      let buffer = '';
      process.stdin.on('data', (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf('\\n');
        if (newline < 0) return;
        const command = JSON.parse(buffer.slice(0, newline));
        const base = { protocolVersion: 1, runId: command.runId, taskId: command.taskId, browserId: command.browserId, agentId: command.agentId, runtimeEpoch: command.runtimeEpoch };
        process.stdout.write(JSON.stringify({ ...base, type: 'ready', sequence: 1 }) + '\\n');
        process.stdout.write(JSON.stringify({ ...base, type: 'result', sequence: 2, summary: 'x'.repeat(40000), outcome: 'success' }) + '\\n', () => process.exit(0));
      });
    `;
    const worker = new AgentWorker({
      onEvent: (event) => order.push(event.type),
      onExit: (details) => order.push(`exit:${details.code}`),
      launch: () => ({ command: process.execPath, args: ['-e', script] })
    });
    await worker.start(startConfig());
    await until(() => order.some((entry) => entry.startsWith('exit:')));
    expect(order).toEqual(['result', 'exit:0']);
  });

  it('releases a worker whose run finished by closing its stdin', async () => {
    const exits: Array<number | null> = [];
    const script = `
      process.stdin.setEncoding('utf8');
      let buffer = '';
      process.stdin.on('data', (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf('\\n');
        if (newline < 0 || buffer.startsWith('done')) return;
        const command = JSON.parse(buffer.slice(0, newline));
        buffer = 'done';
        process.stdout.write(JSON.stringify({ protocolVersion: 1, type: 'ready', runId: command.runId, taskId: command.taskId, browserId: command.browserId, agentId: command.agentId, runtimeEpoch: command.runtimeEpoch, sequence: 1 }) + '\\n');
      });
      process.stdin.on('end', () => process.exit(0));
    `;
    const worker = new AgentWorker({
      onEvent: () => undefined,
      onExit: (details) => exits.push(details.code),
      launch: () => ({ command: process.execPath, args: ['-e', script] })
    });
    await worker.start(startConfig());
    expect(worker.isRunning).toBe(true);
    worker.dispose();
    await until(() => exits.length > 0);
    expect(exits).toEqual([0]);
    expect(worker.isRunning).toBe(false);
  });
});

describe('resolveAgentHostLaunch', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function tree(files: string[]): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'omnibrowser-agent-launch-'));
    directories.push(root);
    for (const file of files) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), '');
    }
    return root;
  }

  function context(overrides: Partial<AgentHostLaunchContext>): AgentHostLaunchContext {
    return { packaged: false, resourcesPath: '/nonexistent-resources', root: '/nonexistent-root', arch: 'arm64', platform: 'darwin', env: {}, ...overrides };
  }

  function failure(resolve: () => unknown): AgentWorkerError {
    try {
      resolve();
    } catch (error) {
      if (error instanceof AgentWorkerError) return error;
      throw error;
    }
    throw new Error('Expected the launch to fail.');
  }

  it('runs a development checkout from its frozen build, then from the agent:build virtual environment', async () => {
    const root = await tree(['agent-runtime/dist/arm64/agent-host/agent-host', 'agent-runtime/.venv-arm64/bin/python']);
    expect(resolveAgentHostLaunch(context({ root }))).toEqual({ command: path.join(root, 'agent-runtime/dist/arm64/agent-host/agent-host'), args: [] });

    await rm(path.join(root, 'agent-runtime/dist'), { recursive: true });
    const source = path.join(root, 'agent-runtime/agent_host.py');
    expect(resolveAgentHostLaunch(context({ root }))).toEqual({ command: path.join(root, 'agent-runtime/.venv-arm64/bin/python'), args: [source] });
    expect(resolveAgentHostLaunch(context({ root, env: { OMNIBROWSER_AGENT_PYTHON: '/opt/python3.12/bin/python3' } })))
      .toEqual({ command: '/opt/python3.12/bin/python3', args: [source] });
  });

  it('explains how to build the runtime instead of trying the system Python', async () => {
    const root = await tree(['agent-runtime/agent_host.py']);
    expect(failure(() => resolveAgentHostLaunch(context({ root }))).code).toBe('runtime-not-built');
  });

  it('uses the sidecar bundled with a package, or the E2E stub of a test package', async () => {
    const resourcesPath = await tree(['agent-host/agent-host', 'test-stub/agent-host']);
    expect(resolveAgentHostLaunch(context({ packaged: true, resourcesPath })).command).toBe(path.join(resourcesPath, 'agent-host/agent-host'));
    await rm(path.join(resourcesPath, 'agent-host'), { recursive: true });
    expect(resolveAgentHostLaunch(context({ packaged: true, resourcesPath })).command).toBe(path.join(resourcesPath, 'test-stub/agent-host'));
    await rm(path.join(resourcesPath, 'test-stub'), { recursive: true });
    expect(failure(() => resolveAgentHostLaunch(context({ packaged: true, resourcesPath }))).code).toBe('runtime-unavailable');
  });

  it('honours an explicit sidecar path relative to the working directory', () => {
    expect(resolveAgentHostLaunch(context({ packaged: true, root: '/work', env: { OMNIBROWSER_AGENT_HOST_PATH: 'build/agent-host' } })))
      .toEqual({ command: '/work/build/agent-host', args: [] });
  });
});
