import type { AgentChatMessage, AgentChatSnapshot, AgentSummary, AgentTimelineEvent } from '../../shared/schemas';

/** The agent a browser's state belongs to and the last sequence seen for it. A new agent restarts the sequence at 0. */
export interface AgentCursor {
  agentId: string;
  sequence: number;
}

export function cursorOf(summary: AgentSummary): AgentCursor {
  return { agentId: summary.agentId, sequence: summary.sequence };
}

/** Summaries are authoritative: only an older summary of the same agent is ignored. */
export function isStaleSummary(known: AgentCursor | undefined, summary: AgentSummary): boolean {
  return known !== undefined && known.agentId === summary.agentId && summary.sequence < known.sequence;
}

/** Whether a loaded conversation lags behind, or belongs to another agent than, its browser's latest summary. */
export function isSnapshotOutdated(loaded: AgentCursor | undefined, summary: AgentSummary): boolean {
  return loaded !== undefined && (loaded.agentId !== summary.agentId || loaded.sequence < summary.sequence);
}

export type TimelineDecision = 'append' | 'ignore' | 'reload';

/** A loaded conversation takes events strictly in order; a gap or another agent needs the whole snapshot again. */
export function timelineDecision(loaded: AgentCursor | undefined, event: AgentTimelineEvent): TimelineDecision {
  if (!loaded) return 'ignore';
  if (loaded.agentId !== event.agentId || event.sequence > loaded.sequence + 1) return 'reload';
  return event.sequence <= loaded.sequence ? 'ignore' : 'append';
}

export function appendTimelineEvent(snapshot: AgentChatSnapshot, event: AgentTimelineEvent, limit = 500): AgentChatSnapshot {
  return {
    ...snapshot,
    summary: { ...snapshot.summary, sequence: event.sequence, updatedAt: event.createdAt },
    timeline: [...snapshot.timeline, event].slice(-limit)
  };
}

export type AgentHistoryItem =
  | { kind: 'message'; key: string; message: AgentChatMessage }
  | { kind: 'event'; key: string; event: AgentTimelineEvent };

/**
 * The conversation as it happened: chat messages interleaved with the agent's activity. Results and errors are already
 * shown as the agent's reply, so only state changes and actions appear as activity.
 */
export function agentHistory(snapshot: AgentChatSnapshot | null): AgentHistoryItem[] {
  if (!snapshot) return [];
  const items: AgentHistoryItem[] = [];
  const events = snapshot.timeline.filter((event) => event.kind === 'state' || event.kind === 'action');
  let eventIndex = 0;
  for (const message of snapshot.messages) {
    while (eventIndex < events.length && events[eventIndex]!.createdAt < message.createdAt) {
      const event = events[eventIndex]!;
      items.push({ kind: 'event', key: event.id, event });
      eventIndex += 1;
    }
    items.push({ kind: 'message', key: message.id, message });
  }
  for (; eventIndex < events.length; eventIndex += 1) {
    const event = events[eventIndex]!;
    items.push({ kind: 'event', key: event.id, event });
  }
  return items;
}
