import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentStore,
  MAX_AGENT_MESSAGES,
  MAX_AGENT_RECORD_BYTES,
  MAX_AGENT_TASKS,
  MAX_AGENT_TIMELINE_EVENTS,
  createStoredAgentRecord,
  type StoredAgentRecord
} from '../../src/main/agents/agent-store';

const directories: string[] = [];
const browserId = '11111111-1111-4111-8111-111111111111';
const profileId = '22222222-2222-4222-8222-222222222222';
const nextProfileId = '33333333-3333-4333-8333-333333333333';

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omnibrowser-agent-store-test-'));
  directories.push(directory);
  return directory;
}

function populatedRecord(messageCount: number, taskCount: number, eventCount: number): StoredAgentRecord {
  const record = createStoredAgentRecord({ browserId, profileId, persistenceKind: 'persistent' }, {
    now: new Date('2026-01-01T00:00:00.000Z'),
    agentId: '44444444-4444-4444-8444-444444444444',
    chatSessionId: '55555555-5555-4555-8555-555555555555'
  });
  const timestamp = '2026-01-01T00:00:00.000Z';
  record.messages = Array.from({ length: messageCount }, (_, index) => ({
    id: randomUUID(),
    role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
    content: `message-${index}-${'x'.repeat(128)}`,
    createdAt: timestamp,
    taskId: null
  }));
  record.tasks = Array.from({ length: taskCount }, (_, index) => ({
    id: randomUUID(),
    instruction: `task-${index}-${'y'.repeat(128)}`,
    state: 'completed' as const,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    completedAt: timestamp,
    outcome: 'success' as const
  }));
  record.timeline = Array.from({ length: eventCount }, (_, index) => ({
    id: randomUUID(),
    browserId: record.browserId,
    agentId: record.agentId,
    taskId: null,
    runId: null,
    sequence: index + 1,
    kind: 'action' as const,
    level: 'info' as const,
    summary: `event-${index}-${'z'.repeat(128)}`,
    createdAt: timestamp
  }));
  record.sequence = eventCount;
  return record;
}

describe('AgentStore', () => {
  it('persists a record atomically and restores it after a restart', async () => {
    const userData = await temporaryDirectory();
    const store = new AgentStore(userData);
    const created = await store.ensure({ browserId, profileId, persistenceKind: 'persistent' });
    created.conversationSummary = 'progress so far';
    created.updatedAt = '2026-01-01T01:00:00.000Z';
    await store.save(created);
    await store.dispose();

    const reopened = new AgentStore(userData);
    const loaded = await reopened.load(browserId);
    expect(loaded.source).toBe('disk');
    expect(loaded.record).toEqual(created);
    expect((await lstat(reopened.pathFor(browserId))).mode & 0o777).toBe(0o600);
    expect(await readdir(path.join(userData, 'agents'))).toEqual([`${browserId}.json`]);
  });

  it('keeps Private records only in memory without creating an agents directory', async () => {
    const userData = await temporaryDirectory();
    const store = new AgentStore(userData);
    const privateRecord = await store.ensure({ browserId, profileId, persistenceKind: 'private' });
    privateRecord.conversationSummary = 'must remain ephemeral';
    await store.save(privateRecord);

    await expect(lstat(path.join(userData, 'agents'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await store.load(browserId)).record?.conversationSummary).toBe('must remain ephemeral');
    await store.dispose();
    expect((await new AgentStore(userData).load(browserId)).record).toBeNull();
  });

  it('enforces collection and byte limits with deterministic oldest-first compaction', async () => {
    const userData = await temporaryDirectory();
    const store = new AgentStore(userData);
    const oversized = populatedRecord(MAX_AGENT_MESSAGES + 25, MAX_AGENT_TASKS + 12, MAX_AGENT_TIMELINE_EVENTS + 30);
    oversized.messages = oversized.messages.map((message) => ({ ...message, content: `${message.content}${'q'.repeat(7000)}` }));
    const lastMessageId = oversized.messages.at(-1)?.id;
    const lastTaskId = oversized.tasks.at(-1)?.id;
    const lastEventId = oversized.timeline.at(-1)?.id;

    const saved = await store.save(oversized);
    expect(saved.messages.length).toBeLessThanOrEqual(MAX_AGENT_MESSAGES);
    expect(saved.tasks.length).toBeLessThanOrEqual(MAX_AGENT_TASKS);
    expect(saved.timeline.length).toBeLessThanOrEqual(MAX_AGENT_TIMELINE_EVENTS);
    expect(saved.messages.at(-1)?.id).toBe(lastMessageId);
    expect(saved.tasks.at(-1)?.id).toBe(lastTaskId);
    expect(saved.timeline.at(-1)?.id).toBe(lastEventId);
    expect(saved.conversationSummary).toContain('mensajes anteriores compactados');
    expect((await lstat(store.pathFor(browserId))).size).toBeLessThanOrEqual(MAX_AGENT_RECORD_BYTES);
  });

  it('preserves corrupt data and returns a fresh record plus a diagnostic', async () => {
    const userData = await temporaryDirectory();
    const agentsDirectory = path.join(userData, 'agents');
    await mkdir(agentsDirectory, { mode: 0o700 });
    await writeFile(path.join(agentsDirectory, `${browserId}.json`), '{ broken json', { encoding: 'utf8', mode: 0o600 });

    const store = new AgentStore(userData, { now: () => new Date('2026-01-02T03:04:05.000Z') });
    const loaded = await store.load(browserId, { profileId, persistenceKind: 'persistent' });
    expect(loaded.source).toBe('new');
    expect(loaded.record?.browserId).toBe(browserId);
    expect(loaded.diagnostic?.message).toMatch(/no era válido/);
    const names = await readdir(agentsDirectory);
    const corruptName = names.find((name) => name.startsWith(`${browserId}.corrupt-2026-01-02T03-04-05-000Z-`));
    expect(corruptName).toBeDefined();
    expect(await readFile(path.join(agentsDirectory, corruptName!), 'utf8')).toBe('{ broken json');
  });

  it('rejects non-UUID browser ids before deriving a filesystem path', async () => {
    const userData = await temporaryDirectory();
    const store = new AgentStore(userData);
    expect(() => store.pathFor('../../escape')).toThrow();
    await expect(store.load('../../escape')).rejects.toThrow();
    expect(await readdir(userData)).toEqual([]);
  });

  it('rotates agent and chat identities when a browser changes profile', async () => {
    const userData = await temporaryDirectory();
    const store = new AgentStore(userData);
    const original = await store.ensure({ browserId, profileId, persistenceKind: 'persistent' });
    const reset = await store.resetForProfile(browserId, nextProfileId, 'persistent');
    expect(reset.profileId).toBe(nextProfileId);
    expect(reset.agentId).not.toBe(original.agentId);
    expect(reset.chatSessionId).not.toBe(original.chatSessionId);
    expect(reset.messages).toEqual([]);
    expect(reset.tasks).toEqual([]);
    expect(JSON.parse(await readFile(store.pathFor(browserId), 'utf8'))).toMatchObject({
      profileId: nextProfileId,
      agentId: reset.agentId,
      chatSessionId: reset.chatSessionId
    });
  });

  it('redacts common secrets and refuses unknown sensitive record fields', async () => {
    const userData = await temporaryDirectory();
    const store = new AgentStore(userData);
    const record = populatedRecord(1, 0, 0);
    record.messages[0]!.content = 'apiKey=sk-this-is-a-secret-value Bearer abcdefghijklmnop';
    const saved = await store.save(record);
    expect(saved.messages[0]?.content).toBe('apiKey=[REDACTED] Bearer [REDACTED]');
    expect(await readFile(store.pathFor(browserId), 'utf8')).not.toContain('this-is-a-secret-value');

    const withCookies = { ...record, cookies: [{ name: 'session', value: 'secret' }] } as unknown as StoredAgentRecord;
    await expect(store.save(withCookies)).rejects.toThrow();
  });

  it('reconciles by deleting records of removed or re-profiled browsers without creating any', async () => {
    const directory = await temporaryDirectory();
    const store = new AgentStore(directory);
    const kept = await store.ensure({ browserId, profileId, persistenceKind: 'persistent' });
    const removedBrowserId = randomUUID();
    await store.ensure({ browserId: removedBrowserId, profileId, persistenceKind: 'persistent' });
    const movedBrowserId = randomUUID();
    await store.ensure({ browserId: movedBrowserId, profileId, persistenceKind: 'persistent' });
    const untouchedBrowserId = randomUUID();

    const records = await store.reconcile([
      { browserId, profileId, persistenceKind: 'persistent' },
      { browserId: movedBrowserId, profileId: nextProfileId, persistenceKind: 'persistent' },
      { browserId: untouchedBrowserId, profileId, persistenceKind: 'persistent' }
    ]);
    expect(records.map((record) => record.agentId)).toEqual([kept.agentId]);
    expect((await readdir(path.join(directory, 'agents'))).filter((name) => name.endsWith('.json'))).toEqual([`${browserId}.json`]);
  });

  it('creates drafts in memory only and persists interrupted progress with redaction', async () => {
    const directory = await temporaryDirectory();
    const store = new AgentStore(directory);
    const draft = store.createDraft({ browserId, profileId, persistenceKind: 'persistent' });
    await expect(lstat(path.join(directory, 'agents'))).rejects.toMatchObject({ code: 'ENOENT' });
    const timestamp = '2026-01-01T00:00:00.000Z';
    const taskId = randomUUID();
    draft.tasks.push({
      id: taskId,
      instruction: 'resume me',
      state: 'paused',
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: timestamp,
      completedAt: null,
      outcome: 'interrupted',
      progressSummary: '- Paso 1: escribir api_key=sk-abcdefghijklmnop'
    });
    draft.activeTaskId = taskId;
    draft.state = 'paused';
    await store.save(draft);
    await store.dispose();

    const restored = new AgentStore(directory);
    const loaded = await restored.load(browserId);
    expect(loaded.record?.tasks[0]?.progressSummary).toBe('- Paso 1: escribir api_key=[REDACTED]');
    await restored.dispose();
  });
});
