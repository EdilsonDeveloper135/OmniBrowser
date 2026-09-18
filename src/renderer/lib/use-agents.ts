import { useRef, useState } from 'react';
import type { OmniEvent } from '../../shared/contracts';
import type {
  AgentChatSnapshot,
  AgentProviderInput,
  AgentProviderPublic,
  AgentSummary,
  AgentTimelineEvent
} from '../../shared/schemas';
import {
  appendTimelineEvent,
  cursorOf,
  isSnapshotOutdated,
  isStaleSummary,
  timelineDecision,
  type AgentCursor
} from './agent-sync';
import { userFacingError } from './errors';
import { useEventCallback } from './use-event-callback';

type Notify = (level: 'info' | 'warning' | 'error', message: string) => void;

// A snapshot request is repeated while newer state keeps arriving during it; this bounds a pathological loop.
const MAX_REFRESH_ROUNDS = 5;

export const KEYCHAIN_FALLBACK_MESSAGE = 'macOS no permitió guardar la clave en el llavero, así que el agente la usará solo hasta que cierres OmniBrowser; la URL y el modelo sí quedan guardados. Para guardar también la clave, reinicia OmniBrowser, vuelve a guardar y elige «Permitir siempre» cuando macOS pida la contraseña de tu Mac.';

/** What the provider dialog tells the person after saving: main keeps the key for the session when the keychain refuses. */
export function providerSaveOutcome(input: AgentProviderInput, saved: AgentProviderPublic): { notice: string; message?: string } {
  if (saved.keyStorage !== 'session') return { notice: 'Proveedor del agente guardado de forma segura.' };
  if (input.rememberKey === false) return { notice: 'Proveedor del agente configurado para esta sesión.' };
  return { notice: 'Proveedor del agente configurado solo para esta sesión.', message: KEYCHAIN_FALLBACK_MESSAGE };
}

function withEntry<V>(map: ReadonlyMap<string, V>, key: string, value: V): ReadonlyMap<string, V> {
  const next = new Map(map);
  next.set(key, value);
  return next;
}

function withoutEntry<V>(map: ReadonlyMap<string, V>, key: string): ReadonlyMap<string, V> {
  if (!map.has(key)) return map;
  const next = new Map(map);
  next.delete(key);
  return next;
}

function withMember(set: ReadonlySet<string>, key: string, member: boolean): ReadonlySet<string> {
  if (set.has(key) === member) return set;
  const next = new Set(set);
  if (member) next.add(key);
  else next.delete(key);
  return next;
}

function retainEntries<V>(map: ReadonlyMap<string, V>, keep: ReadonlySet<string>): ReadonlyMap<string, V> {
  const next = new Map([...map].filter(([key]) => keep.has(key)));
  return next.size === map.size ? map : next;
}

function retainMembers(set: ReadonlySet<string>, keep: ReadonlySet<string>): ReadonlySet<string> {
  const next = new Set([...set].filter((key) => keep.has(key)));
  return next.size === set.size ? set : next;
}

/**
 * Renderer state of the per-card agents. Every browser's state is tracked with the agent it belongs to, so the new,
 * empty agent a card gets after a profile change replaces the old conversation instead of being mistaken for stale
 * state. Conversations are only kept current while their panel is open; opening a panel always reloads it.
 */
export function useAgents(notify: Notify) {
  const [summaries, setSummaries] = useState<ReadonlyMap<string, AgentSummary>>(() => new Map());
  const [snapshots, setSnapshots] = useState<ReadonlyMap<string, AgentChatSnapshot>>(() => new Map());
  const [openPanelIds, setOpenPanelIds] = useState<ReadonlySet<string>>(() => new Set());
  const [loadingIds, setLoadingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [provider, setProvider] = useState<AgentProviderPublic | null>(null);
  const summaryCursors = useRef(new Map<string, AgentCursor>());
  const snapshotCursors = useRef(new Map<string, AgentCursor>());
  const openPanels = useRef(new Set<string>());
  const refreshing = useRef(new Set<string>());
  const pendingRefresh = useRef(new Set<string>());

  const setLoading = (browserId: string, loading: boolean) => setLoadingIds((current) => withMember(current, browserId, loading));
  const setError = (browserId: string, message: string | null) => setErrors((current) => message === null
    ? withoutEntry(current, browserId)
    : withEntry(current, browserId, message));

  const storeSnapshot = (snapshot: AgentChatSnapshot) => {
    const { browserId } = snapshot.summary;
    snapshotCursors.current.set(browserId, cursorOf(snapshot.summary));
    summaryCursors.current.set(browserId, cursorOf(snapshot.summary));
    setSnapshots((current) => withEntry(current, browserId, snapshot));
    setSummaries((current) => withEntry(current, browserId, snapshot.summary));
  };

  const refresh = useEventCallback(async (browserId: string, showLoading = true): Promise<void> => {
    if (refreshing.current.has(browserId)) {
      pendingRefresh.current.add(browserId);
      return;
    }
    refreshing.current.add(browserId);
    if (showLoading) setLoading(browserId, true);
    try {
      for (let round = 0; round < MAX_REFRESH_ROUNDS; round += 1) {
        pendingRefresh.current.delete(browserId);
        try {
          const snapshot = await window.omniBrowser.agents.get(browserId);
          // State that arrived while the request was in flight is newer than its answer: ask again.
          if (isStaleSummary(summaryCursors.current.get(browserId), snapshot.summary)) pendingRefresh.current.add(browserId);
          else {
            storeSnapshot(snapshot);
            setError(browserId, null);
          }
        } catch (error) {
          setError(browserId, userFacingError(error));
        }
        if (!pendingRefresh.current.has(browserId)) break;
      }
    } finally {
      pendingRefresh.current.delete(browserId);
      refreshing.current.delete(browserId);
      if (showLoading) setLoading(browserId, false);
    }
  });

  /** A conversation that can no longer be patched is reloaded while visible and discarded otherwise. */
  const reloadOrDiscard = (browserId: string) => {
    if (openPanels.current.has(browserId)) {
      void refresh(browserId, false);
      return;
    }
    snapshotCursors.current.delete(browserId);
    setSnapshots((current) => withoutEntry(current, browserId));
  };

  const applySummary = (summary: AgentSummary) => {
    const { browserId } = summary;
    if (isStaleSummary(summaryCursors.current.get(browserId), summary)) return;
    summaryCursors.current.set(browserId, cursorOf(summary));
    setSummaries((current) => withEntry(current, browserId, summary));
    const loaded = snapshotCursors.current.get(browserId);
    if (!loaded) return;
    if (isSnapshotOutdated(loaded, summary)) {
      reloadOrDiscard(browserId);
      return;
    }
    setSnapshots((current) => {
      const existing = current.get(browserId);
      return existing ? withEntry(current, browserId, { ...existing, summary }) : current;
    });
  };

  const applyTimelineEvent = (event: AgentTimelineEvent) => {
    const { browserId } = event;
    const decision = timelineDecision(snapshotCursors.current.get(browserId), event);
    if (decision === 'ignore') return;
    if (decision === 'reload') {
      reloadOrDiscard(browserId);
      return;
    }
    snapshotCursors.current.set(browserId, { agentId: event.agentId, sequence: event.sequence });
    setSnapshots((current) => {
      const existing = current.get(browserId);
      return existing ? withEntry(current, browserId, appendTimelineEvent(existing, event)) : current;
    });
    // Results, errors and queue changes also change messages and tasks, which only a snapshot carries.
    if (event.kind !== 'action' && openPanels.current.has(browserId)) void refresh(browserId, false);
  };

  const handleEvent = useEventCallback((event: OmniEvent) => {
    if (event.type === 'agent-state') applySummary(event.summary);
    else if (event.type === 'agent-event') applyTimelineEvent(event.event);
  });

  const load = useEventCallback(async (isActive: () => boolean): Promise<void> => {
    const [listed, configured] = await Promise.allSettled([
      window.omniBrowser.agents.list(),
      window.omniBrowser.agents.getProvider()
    ]);
    if (!isActive()) return;
    if (listed.status === 'fulfilled') for (const summary of listed.value) applySummary(summary);
    else notify('error', `No se pudieron cargar los agentes: ${userFacingError(listed.reason)}`);
    if (configured.status === 'fulfilled') setProvider(configured.value);
    else notify('warning', `No se pudo cargar el proveedor del agente: ${userFacingError(configured.reason)}`);
  });

  const setPanelOpen = useEventCallback((browserId: string, open: boolean) => {
    if (open) openPanels.current.add(browserId);
    else openPanels.current.delete(browserId);
    setOpenPanelIds((current) => withMember(current, browserId, open));
    if (open) void refresh(browserId);
  });

  const runAction = useEventCallback(async (browserId: string, operation: () => Promise<AgentChatSnapshot>): Promise<void> => {
    setLoading(browserId, true);
    setError(browserId, null);
    try {
      const snapshot = await operation();
      if (isStaleSummary(summaryCursors.current.get(browserId), snapshot.summary)) void refresh(browserId, false);
      else storeSnapshot(snapshot);
    } catch (error) {
      const message = userFacingError(error);
      setError(browserId, message);
      notify('error', message);
    } finally {
      setLoading(browserId, false);
    }
  });

  // Provider failures are shown inside the provider dialog, next to the fields they concern.
  const saveProvider = useEventCallback(async (input: AgentProviderInput): Promise<{ ok: boolean; message?: string }> => {
    try {
      const saved = await window.omniBrowser.agents.saveProvider(input);
      setProvider(saved);
      setSummaries((current) => new Map([...current].map(([id, summary]) => [id, { ...summary, requiresProvider: !saved.configured }])));
      const outcome = providerSaveOutcome(input, saved);
      notify(outcome.message ? 'warning' : 'info', outcome.notice);
      return outcome.message ? { ok: true, message: outcome.message } : { ok: true };
    } catch (error) {
      return { ok: false, message: userFacingError(error) };
    }
  });

  /** The dialog shows the current key state, which main may have changed (a key the keychain refused counts as missing). */
  const refreshProvider = useEventCallback(async (): Promise<void> => {
    try {
      setProvider(await window.omniBrowser.agents.getProvider());
    } catch {
      // The dialog keeps the last known state; saving reports any real problem.
    }
  });

  const testProvider = useEventCallback(async (input: AgentProviderInput): Promise<{ ok: boolean; message: string }> => {
    try {
      return { ok: true, message: (await window.omniBrowser.agents.testProvider(input)).message };
    } catch (error) {
      return { ok: false, message: userFacingError(error) };
    }
  });

  /** Forgets every agent of a browser that is no longer in the workspace. */
  const retain = useEventCallback((browserIds: ReadonlySet<string>) => {
    for (const cursors of [summaryCursors.current, snapshotCursors.current]) {
      for (const id of [...cursors.keys()]) if (!browserIds.has(id)) cursors.delete(id);
    }
    for (const id of [...openPanels.current]) if (!browserIds.has(id)) openPanels.current.delete(id);
    setOpenPanelIds((current) => retainMembers(current, browserIds));
    setLoadingIds((current) => retainMembers(current, browserIds));
    setSnapshots((current) => retainEntries(current, browserIds));
    setSummaries((current) => retainEntries(current, browserIds));
    setErrors((current) => retainEntries(current, browserIds));
  });

  return {
    summaries,
    snapshots,
    openPanelIds,
    loadingIds,
    errors,
    provider,
    handleEvent,
    load,
    setPanelOpen,
    runAction,
    saveProvider,
    refreshProvider,
    testProvider,
    retain
  };
}
