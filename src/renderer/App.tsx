import { LoaderCircle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ZOOM_STEP } from '../shared/constants';
import type { OmniEvent } from '../shared/contracts';
import { clampCamera, roundZoom, zoomAroundPoint } from '../shared/geometry';
import type { BrowserSnapshot, Camera, ProfileRecord, WorkspaceSnapshot, WorldRect, ZoneRecord } from '../shared/schemas';
import { raiseToTop } from '../shared/z-order';
import { AgentProviderModal } from './components/AgentProviderModal';
import { NoticeToast, type NoticeState } from './components/NoticeToast';
import { ProfileRail, type SidebarDropDestination } from './components/ProfileRail';
import { PromptModal } from './components/PromptModal';
import { StatusBar } from './components/StatusBar';
import { Toolbar } from './components/Toolbar';
import { WorkspaceCanvas, type LocateRequest } from './components/WorkspaceCanvas';
import { userFacingError } from './lib/errors';
import { mergeBrowserState, mergeWorkspaceSnapshot, type ActiveInteraction } from './lib/snapshot-merge';
import { useAgents } from './lib/use-agents';

const ZONE_COLORS = ['#2f81f7', '#a371f7', '#3fb950', '#f0883e', '#db61a2', '#39c5cf'];

export function App() {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [selectedBrowserIds, setSelectedBrowserIds] = useState<Set<string>>(() => new Set());
  const [fullscreenBrowserId, setFullscreenBrowserId] = useState<string | null>(null);
  const [locateRequest, setLocateRequest] = useState<LocateRequest | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [agentProviderOpen, setAgentProviderOpen] = useState(false);
  const [pendingZoneCreation, setPendingZoneCreation] = useState<{
    browserIds: string[];
    profileId: string;
    defaultName: string;
  } | null>(null);
  const interactionRef = useRef<ActiveInteraction>(null);
  const noticeSequenceRef = useRef(0);
  const locateSequenceRef = useRef(0);
  const viewportSizeRef = useRef({ width: 0, height: 0 });
  const previousActiveBrowserIdRef = useRef<string | null>(null);
  const previousActiveProfileIdRef = useRef<string | null>(null);

  const pushNotice = useCallback((level: NoticeState['level'], message: string) => {
    noticeSequenceRef.current += 1;
    const next = { id: noticeSequenceRef.current, level, message };
    setNotice(next);
    window.setTimeout(() => setNotice((current) => current?.id === next.id ? null : current), 5000);
  }, []);

  const agents = useAgents(pushNotice);
  const { handleEvent: handleAgentEvent, load: loadAgents, retain: retainAgents } = agents;
  const closeAgentProvider = useCallback(() => setAgentProviderOpen(false), []);

  useEffect(() => {
    let active = true;
    const unsubscribe = window.omniBrowser.events.subscribe((event: OmniEvent) => {
      if (!active) return;
      if (event.type === 'workspace-snapshot') setSnapshot((current) => mergeWorkspaceSnapshot(current, event.snapshot, interactionRef.current));
      if (event.type === 'browser-state') setSnapshot((current) => mergeBrowserState(current, event.browser));
      if (event.type === 'native-browser-click') {
        setSelectedBrowserIds((current) => {
          if (!event.shiftKey) return new Set([event.browserId]);
          const next = new Set(current);
          if (next.has(event.browserId)) next.delete(event.browserId); else next.add(event.browserId);
          return next;
        });
      }
      if (event.type === 'native-browser-escape') {
        setFullscreenBrowserId((current) => current === event.browserId ? null : current);
      }
      if (event.type === 'save-status') setSnapshot((current) => current ? { ...current, saveStatus: event.status } : current);
      if (event.type === 'notice') pushNotice(event.level, event.message);
      if (event.type === 'agent-state' || event.type === 'agent-event') handleAgentEvent(event);
    });
    void loadAgents(() => active);
    window.omniBrowser.bootstrap().then((initial) => {
      if (!active) return;
      setSnapshot(initial);
      if (initial.selectedBrowserId) setSelectedBrowserIds(new Set([initial.selectedBrowserId]));
      const selected = initial.browsers.find((browser) => browser.id === initial.selectedBrowserId);
      setActiveProfileId(selected?.profileId ?? initial.profiles[0]?.id ?? null);
    }).catch((error: unknown) => {
      if (active) setFatalError(userFacingError(error));
    });
    return () => { active = false; unsubscribe(); };
  }, [handleAgentEvent, loadAgents, pushNotice]);

  useEffect(() => {
    if (!snapshot) return;
    const activeBrowser = snapshot.browsers.find((browser) => browser.id === snapshot.selectedBrowserId);
    const activeBrowserChanged = previousActiveBrowserIdRef.current !== snapshot.selectedBrowserId;
    const activeBrowserProfileChanged = previousActiveProfileIdRef.current !== (activeBrowser?.profileId ?? null);
    previousActiveBrowserIdRef.current = snapshot.selectedBrowserId;
    previousActiveProfileIdRef.current = activeBrowser?.profileId ?? null;
    if ((activeBrowserChanged || activeBrowserProfileChanged) && activeBrowser) setActiveProfileId(activeBrowser.profileId);
    else if (!activeProfileId || !snapshot.profiles.some((profile) => profile.id === activeProfileId)) setActiveProfileId(snapshot.profiles[0]?.id ?? null);
    const ids = new Set(snapshot.browsers.map((browser) => browser.id));
    retainAgents(ids);
    setSelectedBrowserIds((current) => {
      const next = new Set([...current].filter((id) => ids.has(id)));
      if (activeBrowserChanged && snapshot.selectedBrowserId && !next.has(snapshot.selectedBrowserId)) {
        return new Set([snapshot.selectedBrowserId]);
      }
      const unchanged = next.size === current.size && [...next].every((id) => current.has(id));
      return unchanged ? current : next;
    });
  }, [snapshot, activeProfileId, retainAgents]);

  const run = async <T,>(operation: () => Promise<T>, apply?: (value: T) => void): Promise<T | undefined> => {
    try {
      const value = await operation();
      apply?.(value);
      return value;
    } catch (error) {
      pushNotice('error', userFacingError(error));
      return undefined;
    }
  };

  if (fatalError) return <div className="fatal-state"><strong>No se pudo iniciar OmniBrowser</strong><span>{fatalError}</span></div>;
  if (!snapshot) return <div className="loading-state"><LoaderCircle className="spin" size={24} /><span>Restaurando workspace…</span></div>;

  const applySnapshot = (next: WorkspaceSnapshot) => setSnapshot((current) => mergeWorkspaceSnapshot(current, next, interactionRef.current));
  const applySnapshotPreservingCamera = (next: WorkspaceSnapshot) => setSnapshot((current) => {
    const merged = mergeWorkspaceSnapshot(current, next, interactionRef.current);
    return current ? { ...merged, camera: current.camera } : merged;
  });
  const applySnapshotAndSelection = (next: WorkspaceSnapshot) => {
    applySnapshot(next);
    if (next.selectedBrowserId) setSelectedBrowserIds(new Set([next.selectedBrowserId]));
  };
  const updateBrowserRects = (rects: Map<string, WorldRect>) => {
    setSnapshot((current) => current ? {
      ...current,
      browsers: current.browsers.map((browser) => {
        const rect = rects.get(browser.id);
        return rect ? { ...browser, worldRect: rect } : browser;
      })
    } : current);
  };
  const updateCamera = (update: (camera: Camera) => Camera) => setSnapshot((current) => current ? { ...current, camera: clampCamera(update(current.camera)) } : current);
  const zoomStep = (direction: 1 | -1) => {
    const center = { x: viewportSizeRef.current.width / 2, y: viewportSizeRef.current.height / 2 };
    updateCamera((camera) => zoomAroundPoint(camera, roundZoom(camera.zoom + direction * ZOOM_STEP), center));
  };
  const focus = async (browserId: string, options?: { focusContents?: boolean }) => {
    setSnapshot((current) => current ? { ...current, selectedBrowserId: browserId, browsers: raiseToTop(current.browsers, browserId) } : current);
    await run(() => window.omniBrowser.browsers.focus(browserId, options), applySnapshotPreservingCamera);
  };
  const clearFocus = async () => { await run(() => window.omniBrowser.workspace.clearFocus(), applySnapshot); };

  const createProfile = async (name: string, kind: ProfileRecord['kind']): Promise<boolean> => {
    const next = await run(() => kind === 'persistent' ? window.omniBrowser.profiles.createPersistent(name) : window.omniBrowser.profiles.createPrivate(name), applySnapshot);
    if (!next) return false;
    const created = next.profiles.find((profile) => profile.name === name.trim()) ?? next.profiles.at(-1);
    if (created) setActiveProfileId(created.id);
    return true;
  };

  const locate = (browserId: string) => {
    locateSequenceRef.current += 1;
    setLocateRequest({ browserId, token: locateSequenceRef.current });
  };

  const createZone = async (browserIds: string[]) => {
    if (!snapshot) return;
    const browsers = browserIds.map((id) => snapshot.browsers.find((browser) => browser.id === id)).filter((browser): browser is BrowserSnapshot => Boolean(browser));
    const profileIds = new Set(browsers.map((browser) => browser.profileId));
    if (browsers.length === 0 || profileIds.size !== 1) {
      pushNotice('warning', 'Una zona sólo puede contener navegadores del mismo perfil.');
      return;
    }
    const defaultName = `Zona ${snapshot.zones.length + 1}`;
    setPendingZoneCreation({
      browserIds,
      profileId: browsers[0]!.profileId,
      defaultName
    });
  };

  const handleConfirmZone = async (name: string) => {
    if (!pendingZoneCreation || !snapshot) return;
    const { browserIds, profileId } = pendingZoneCreation;
    setPendingZoneCreation(null);
    const color = ZONE_COLORS[snapshot.zones.length % ZONE_COLORS.length]!;
    await run(() => window.omniBrowser.workspace.createZone(profileId, name, color, browserIds), applySnapshot);
  };

  const handleCancelZone = () => {
    setPendingZoneCreation(null);
  };

  const closeBrowser = async (browserId: string) => {
    if (fullscreenBrowserId === browserId) setFullscreenBrowserId(null);
    await run(() => window.omniBrowser.browsers.close(browserId), applySnapshot);
  };

  const dropBrowser = async (browserId: string, destination: SidebarDropDestination) => {
    const browser = snapshot.browsers.find((candidate) => candidate.id === browserId);
    if (!browser) return;
    if (destination.kind === 'pinned') {
      await run(() => window.omniBrowser.browsers.setSidebarPinned([browserId], true), applySnapshot);
      return;
    }
    if (destination.kind === 'root') {
      await run(() => window.omniBrowser.workspace.assignZone([browserId], null), applySnapshot);
      return;
    }
    if (destination.kind === 'browser') {
      if (destination.id === browserId) return;
      const order = snapshot.browserOrder.filter((id) => id !== browserId);
      order.splice(Math.max(0, order.indexOf(destination.id)), 0, browserId);
      await run(() => window.omniBrowser.workspace.setBrowserOrder(order), applySnapshot);
      return;
    }
    if (destination.kind === 'profile') {
      if (browser.profileId !== destination.id) await run(() => window.omniBrowser.browsers.assignProfile(browserId, destination.id), applySnapshot);
      return;
    }
    const targetZone = destination.kind === 'zone'
      ? snapshot.zones.find((zone) => zone.id === destination.id)
      : snapshot.zones.find((zone) => snapshot.stacks.find((stack) => stack.id === destination.id)?.zoneId === zone.id);
    if (!targetZone) return;
    let current = browser;
    if (current.profileId !== targetZone.profileId) {
      const next = await run(() => window.omniBrowser.browsers.assignProfile(browserId, targetZone.profileId), applySnapshot);
      current = next?.browsers.find((candidate) => candidate.id === browserId) ?? current;
      if (current.profileId !== targetZone.profileId) return;
    }
    if (current.zoneId !== targetZone.id) {
      const next = await run(() => window.omniBrowser.workspace.assignZone([browserId], targetZone.id), applySnapshot);
      current = next?.browsers.find((candidate) => candidate.id === browserId) ?? current;
      if (current.zoneId !== targetZone.id) return;
    }
    if (destination.kind === 'stack') await run(() => window.omniBrowser.workspace.addStackMember(destination.id, browserId), applySnapshot);
  };

  const setZoneCollapsed = async (zone: ZoneRecord, collapsed: boolean) => {
    await run(() => window.omniBrowser.workspace.setZoneCollapsed(zone.id, collapsed), applySnapshot);
  };

  return (
    <div className={`app-shell ${fullscreenBrowserId ? 'is-immersive' : ''}`}>
      <ProfileRail
        activeProfileId={activeProfileId}
        onClose={(browserId) => void closeBrowser(browserId)}
        onCreate={createProfile}
        onDropBrowser={(browserId, destination) => void dropBrowser(browserId, destination)}
        onLocate={locate}
        onSelectProfile={setActiveProfileId}
        onSelectStackMember={(stackId, browserId) => void run(() => window.omniBrowser.workspace.selectStackMember(stackId, browserId), applySnapshot)}
        onToggleSidebarPin={(browser) => void run(() => window.omniBrowser.browsers.setSidebarPinned([browser.id], !browser.pin.sidebar), applySnapshot)}
        onToggleZone={(zone) => void setZoneCollapsed(zone, !zone.collapsed)}
        selectedBrowserIds={selectedBrowserIds}
        snapshot={snapshot}
      />
      <Toolbar
        onCreateBrowser={() => activeProfileId ? run(() => window.omniBrowser.browsers.create(activeProfileId), applySnapshotAndSelection).then(() => undefined) : Promise.resolve()}
        onResetCamera={() => updateCamera(() => ({ panX: 0, panY: 0, zoom: 1 }))}
        onToggleSnap={() => void run(() => window.omniBrowser.workspace.setPreferences({ snapEnabled: !snapshot.preferences.snapEnabled }), applySnapshot)}
        onZoom={zoomStep}
        saveStatus={snapshot.saveStatus}
        snapEnabled={snapshot.preferences.snapEnabled}
        zoom={snapshot.camera.zoom}
      />
      <WorkspaceCanvas
        agentErrors={agents.errors}
        agentLoadingIds={agents.loadingIds}
        agentProviderReady={agents.provider?.configured ?? false}
        agentSnapshots={agents.snapshots}
        agentSummaries={agents.summaries}
        fullscreenBrowserId={fullscreenBrowserId}
        locateRequest={locateRequest}
        modalActive={pendingZoneCreation !== null || agentProviderOpen}
        noticeId={notice?.id ?? null}
        onAgentPanelOpenChange={agents.setPanelOpen}
        onAgentPause={(browserId) => agents.runAction(browserId, () => window.omniBrowser.agents.pause(browserId))}
        onAgentResume={(browserId) => agents.runAction(browserId, () => window.omniBrowser.agents.resume(browserId))}
        onAgentSend={(browserId, instruction) => agents.runAction(browserId, () => window.omniBrowser.agents.send(browserId, instruction))}
        onAgentStop={(browserId) => agents.runAction(browserId, () => window.omniBrowser.agents.stop(browserId))}
        onAssignProfile={(browserId, profileId) => run(() => window.omniBrowser.browsers.assignProfile(browserId, profileId), applySnapshot).then(() => undefined)}
        onBack={(browserId) => run(() => window.omniBrowser.browsers.back(browserId)).then(() => undefined)}
        onClearFocus={clearFocus}
        onClose={closeBrowser}
        onCreateStack={(zoneId, browserIds) => run(() => window.omniBrowser.workspace.createStack(zoneId, browserIds), applySnapshot).then(() => undefined)}
        onCreateZone={createZone}
        onDuplicate={(browserIds) => run(() => window.omniBrowser.browsers.duplicate(browserIds), applySnapshotAndSelection).then(() => undefined)}
        onFocus={focus}
        onForward={(browserId) => run(() => window.omniBrowser.browsers.forward(browserId)).then(() => undefined)}
        onFullscreenChange={setFullscreenBrowserId}
        onInteractionChange={(interaction) => { interactionRef.current = interaction; }}
        onNavigate={(browserId, url) => run(() => window.omniBrowser.browsers.navigate(browserId, url)).then(() => undefined)}
        onOpenAgentSettings={() => { setAgentProviderOpen(true); void agents.refreshProvider(); }}
        onReload={(browserId) => run(() => window.omniBrowser.browsers.reload(browserId)).then(() => undefined)}
        onSelectionChange={setSelectedBrowserIds}
        onSelectStackMember={(stackId, browserId) => run(() => window.omniBrowser.workspace.selectStackMember(stackId, browserId), applySnapshot).then(() => undefined)}
        onSetLocked={(browserIds, locked) => run(() => window.omniBrowser.browsers.setPositionLocked(browserIds, locked), applySnapshot).then(() => undefined)}
        onSetPresentation={(browserIds, presentation) => run(() => window.omniBrowser.browsers.setPresentation(browserIds, presentation), applySnapshot).then(() => undefined)}
        onSetSidebarPinned={(browserIds, pinned) => run(() => window.omniBrowser.browsers.setSidebarPinned(browserIds, pinned), applySnapshot).then(() => undefined)}
        onSetViewportPin={(browserId, viewport) => run(() => window.omniBrowser.browsers.setViewportPin(browserId, viewport), applySnapshot).then(() => undefined)}
        onSetZoneCollapsed={setZoneCollapsed}
        onSleep={(browserId) => run(() => window.omniBrowser.browsers.sleep(browserId), applySnapshot).then(() => undefined)}
        onStop={(browserId) => run(() => window.omniBrowser.browsers.stop(browserId)).then(() => undefined)}
        onUnstack={(stackId) => run(() => window.omniBrowser.workspace.unstack(stackId), applySnapshot).then(() => undefined)}
        onUpdateBrowserRects={updateBrowserRects}
        onUpdateCamera={updateCamera}
        onViewportChange={(size) => { viewportSizeRef.current = size; }}
        onWake={(browserId) => run(() => window.omniBrowser.browsers.wake(browserId), applySnapshot).then(() => undefined)}
        openAgentPanelIds={agents.openPanelIds}
        selectedBrowserIds={selectedBrowserIds}
        snapshot={snapshot}
      />
      <StatusBar browserCount={snapshot.browsers.length} />
      {notice ? <NoticeToast notice={notice} onClose={() => setNotice(null)} /> : null}
      <PromptModal
        isOpen={pendingZoneCreation !== null}
        title="Crear nueva zona"
        description="Asigna un nombre a la zona para agrupar los navegadores seleccionados."
        placeholder="Nombre de la zona"
        defaultValue={pendingZoneCreation?.defaultName ?? ''}
        confirmLabel="Crear zona"
        cancelLabel="Cancelar"
        onConfirm={handleConfirmZone}
        onCancel={handleCancelZone}
      />
      <AgentProviderModal
        isOpen={agentProviderOpen}
        onClose={closeAgentProvider}
        onSave={agents.saveProvider}
        onTest={agents.testProvider}
        provider={agents.provider}
      />
    </div>
  );
}
