import { describe, expect, it } from 'vitest';
import {
  agentHistory,
  appendTimelineEvent,
  isSnapshotOutdated,
  isStaleSummary,
  timelineDecision
} from '../../src/renderer/lib/agent-sync';
import type { AgentChatSnapshot, AgentSummary, AgentTimelineEvent } from '../../src/shared/schemas';

function summary(agentId: string, sequence: number): AgentSummary {
  return {
    browserId: 'browser-1',
    agentId,
    chatSessionId: `chat-${agentId}`,
    state: 'idle',
    activeTaskId: null,
    queuedTaskCount: 0,
    sequence,
    updatedAt: '2026-01-01T00:00:00.000Z',
    requiresProvider: false
  };
}

function event(agentId: string, sequence: number, overrides: Partial<AgentTimelineEvent> = {}): AgentTimelineEvent {
  return {
    id: `event-${agentId}-${sequence}`,
    browserId: 'browser-1',
    agentId,
    taskId: null,
    runId: null,
    sequence,
    kind: 'action',
    level: 'info',
    summary: `step ${sequence}`,
    createdAt: `2026-01-01T00:00:0${sequence}.000Z`,
    ...overrides
  };
}

describe('agent state synchronization', () => {
  it('ignores only older summaries of the same agent, so a new agent after a profile change always wins', () => {
    expect(isStaleSummary(undefined, summary('a', 0))).toBe(false);
    expect(isStaleSummary({ agentId: 'a', sequence: 5 }, summary('a', 4))).toBe(true);
    expect(isStaleSummary({ agentId: 'a', sequence: 5 }, summary('a', 5))).toBe(false);
    expect(isStaleSummary({ agentId: 'a', sequence: 42 }, summary('b', 0))).toBe(false);
  });

  it('reloads a loaded conversation that lags behind or belongs to another agent', () => {
    expect(isSnapshotOutdated(undefined, summary('a', 3))).toBe(false);
    expect(isSnapshotOutdated({ agentId: 'a', sequence: 3 }, summary('a', 3))).toBe(false);
    expect(isSnapshotOutdated({ agentId: 'a', sequence: 2 }, summary('a', 3))).toBe(true);
    expect(isSnapshotOutdated({ agentId: 'a', sequence: 9 }, summary('b', 0))).toBe(true);
  });

  it('appends timeline events strictly in order', () => {
    expect(timelineDecision(undefined, event('a', 1))).toBe('ignore');
    expect(timelineDecision({ agentId: 'a', sequence: 3 }, event('a', 3))).toBe('ignore');
    expect(timelineDecision({ agentId: 'a', sequence: 3 }, event('a', 4))).toBe('append');
    expect(timelineDecision({ agentId: 'a', sequence: 3 }, event('a', 6))).toBe('reload');
    expect(timelineDecision({ agentId: 'a', sequence: 3 }, event('b', 1))).toBe('reload');

    const snapshot: AgentChatSnapshot = { summary: summary('a', 3), messages: [], tasks: [], timeline: [event('a', 3)], conversationSummary: '' };
    const next = appendTimelineEvent(snapshot, event('a', 4), 1);
    expect(next.summary.sequence).toBe(4);
    expect(next.timeline.map((candidate) => candidate.sequence)).toEqual([4]);
  });

  it('interleaves messages and activity chronologically and leaves results to the agent reply', () => {
    const snapshot: AgentChatSnapshot = {
      summary: summary('a', 5),
      conversationSummary: '',
      tasks: [],
      messages: [
        { id: 'user', role: 'user', content: 'Busca', createdAt: '2026-01-01T00:00:01.000Z', taskId: 't' },
        { id: 'reply', role: 'assistant', content: 'Listo', createdAt: '2026-01-01T00:00:05.000Z', taskId: 't' }
      ],
      timeline: [
        event('a', 1, { kind: 'state', createdAt: '2026-01-01T00:00:01.000Z' }),
        event('a', 2, { createdAt: '2026-01-01T00:00:03.000Z' }),
        event('a', 3, { kind: 'result', createdAt: '2026-01-01T00:00:05.000Z' }),
        event('a', 4, { kind: 'error', level: 'error', createdAt: '2026-01-01T00:00:05.000Z' }),
        event('a', 5, { kind: 'state', createdAt: '2026-01-01T00:00:06.000Z' })
      ]
    };
    expect(agentHistory(snapshot).map((item) => item.key)).toEqual(['user', 'event-a-1', 'event-a-2', 'reply', 'event-a-5']);
    expect(agentHistory(null)).toEqual([]);
  });
});
