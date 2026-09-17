import { LoaderCircle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ZOOM_STEP } from '../shared/constants';
import { clampCamera, roundZoom, zoomAroundPoint } from '../shared/geometry';
import type { OmniEvent } from '../shared/contracts';
import type { BrowserSnapshot, Camera, ProfileRecord, WorkspaceSnapshot, WorldRect } from '../shared/schemas';
import { raiseToTop } from '../shared/z-order';
import { ProfileRail } from './components/ProfileRail';
import { Toolbar } from './components/Toolbar';
import { WorkspaceCanvas } from './components/WorkspaceCanvas';
import { StatusBar } from './components/StatusBar';
import { NoticeToast, type NoticeState } from './components/NoticeToast';
import { userFacingError } from './lib/errors';
import { mergeBrowserState, mergeWorkspaceSnapshot, type ActiveInteraction } from './lib/snapshot-merge';

export function App() {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const interactionRef = useRef<ActiveInteraction>(null);
  const noticeSequenceRef = useRef(0);
  const viewportSizeRef = useRef({ width: 0, height: 0 });

  const pushNotice = useCallback((level: NoticeState['level'], message: string) => {
    noticeSequenceRef.current += 1;
    const next = { id: noticeSequenceRef.current, level, message };
    setNotice(next);
    window.setTimeout(() => setNotice((current) => current?.id === next.id ? null : current), 5000);
  }, []);

  useEffect(() => {
    let active = true;
    const unsubscribe = window.omniBrowser.events.subscribe((event: OmniEvent) => {
      if (!active) return;
      if (event.type === 'workspace-snapshot') setSnapshot((current) => mergeWorkspaceSnapshot(current, event.snapshot, interactionRef.current));
      if (event.type === 'browser-state') setSnapshot((current) => mergeBrowserState(current, event.browser));
      if (event.type === 'save-status') setSnapshot((current) => current ? { ...current, saveStatus: event.status } : current);
      if (event.type === 'notice') pushNotice(event.level, event.message);
    });
    window.omniBrowser.bootstrap().then((initial) => {
      if (!active) return;
      setSnapshot(initial);
      const selected = initial.browsers.find((browser) => browser.id === initial.selectedBrowserId);
      setActiveProfileId(selected?.profileId ?? initial.profiles[0]?.id ?? null);
    }).catch((error: unknown) => {
      if (active) setFatalError(userFacingError(error));
    });
    return () => { active = false; unsubscribe(); };
  }, [pushNotice]);

  useEffect(() => {
    if (!snapshot) return;
    if (!activeProfileId || !snapshot.profiles.some((profile) => profile.id === activeProfileId)) {
      setActiveProfileId(snapshot.profiles[0]?.id ?? null);
    }
  }, [snapshot, activeProfileId]);

  const selectedBrowser = useMemo<BrowserSnapshot | undefined>(
    () => snapshot?.browsers.find((browser) => browser.id === snapshot.selectedBrowserId),
    [snapshot]
  );

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

  if (fatalError) {
    return <div className="fatal-state"><strong>No se pudo iniciar OmniBrowser</strong><span>{fatalError}</span></div>;
  }
  if (!snapshot) {
    return <div className="loading-state"><LoaderCircle className="spin" size={24} /><span>Restaurando workspace…</span></div>;
  }

  const updateBrowserRect = (browserId: string, rect: WorldRect) => {
    setSnapshot((current) => current ? {
      ...current,
      browsers: current.browsers.map((browser) => browser.id === browserId ? { ...browser, worldRect: rect } : browser)
    } : current);
  };

  const updateCamera = (update: (camera: Camera) => Camera) => {
    setSnapshot((current) => current ? { ...current, camera: clampCamera(update(current.camera)) } : current);
  };
  const zoomStep = (direction: 1 | -1) => {
    const center = { x: viewportSizeRef.current.width / 2, y: viewportSizeRef.current.height / 2 };
    updateCamera((camera) => zoomAroundPoint(camera, roundZoom(camera.zoom + direction * ZOOM_STEP), center));
  };
  const applySnapshot = (next: WorkspaceSnapshot) => setSnapshot((current) => mergeWorkspaceSnapshot(current, next, interactionRef.current));
  const focus = async (browserId: string, options?: { focusContents?: boolean }) => {
    setSnapshot((current) => current ? { ...current, selectedBrowserId: browserId, browsers: raiseToTop(current.browsers, browserId) } : current);
    await run(() => window.omniBrowser.browsers.focus(browserId, options));
  };

  const createProfile = async (name: string, kind: ProfileRecord['kind']): Promise<boolean> => {
    const next = await run(
      () => kind === 'persistent' ? window.omniBrowser.profiles.createPersistent(name) : window.omniBrowser.profiles.createTemporary(name),
      applySnapshot
    );
    if (!next) return false;
    const created = next.profiles.find((profile) => profile.name === name.trim()) ?? next.profiles.at(-1);
    if (created) setActiveProfileId(created.id);
    return true;
  };

  return (
    <div className="app-shell">
      <ProfileRail activeProfileId={activeProfileId} onCreate={createProfile} onSelect={setActiveProfileId} profiles={snapshot.profiles} />
      <Toolbar
        browser={selectedBrowser}
        onBack={() => selectedBrowser ? run(() => window.omniBrowser.browsers.back(selectedBrowser.id)).then(() => undefined) : Promise.resolve()}
        onCreateBrowser={() => activeProfileId ? run(() => window.omniBrowser.browsers.create(activeProfileId), applySnapshot).then(() => undefined) : Promise.resolve()}
        onForward={() => selectedBrowser ? run(() => window.omniBrowser.browsers.forward(selectedBrowser.id)).then(() => undefined) : Promise.resolve()}
        onNavigate={(url) => selectedBrowser ? run(() => window.omniBrowser.browsers.navigate(selectedBrowser.id, url)).then(() => undefined) : Promise.resolve()}
        onReload={() => selectedBrowser ? run(() => window.omniBrowser.browsers.reload(selectedBrowser.id)).then(() => undefined) : Promise.resolve()}
        onZoom={zoomStep}
        saveStatus={snapshot.saveStatus}
        zoom={snapshot.camera.zoom}
      />
      <WorkspaceCanvas
        noticeId={notice?.id ?? null}
        onAssignProfile={(browserId, profileId) => run(() => window.omniBrowser.browsers.assignProfile(browserId, profileId), applySnapshot).then(() => undefined)}
        onClose={(browserId) => run(() => window.omniBrowser.browsers.close(browserId), applySnapshot).then(() => undefined)}
        onFocus={focus}
        onInteractionChange={(interaction) => { interactionRef.current = interaction; }}
        onReload={(browserId) => run(() => window.omniBrowser.browsers.reload(browserId)).then(() => undefined)}
        onSleep={(browserId) => run(() => window.omniBrowser.browsers.sleep(browserId), applySnapshot).then(() => undefined)}
        onUpdateBrowserRect={updateBrowserRect}
        onUpdateCamera={updateCamera}
        onViewportChange={(size) => { viewportSizeRef.current = size; }}
        onWake={(browserId) => run(() => window.omniBrowser.browsers.wake(browserId), applySnapshot).then(() => undefined)}
        snapshot={snapshot}
      />
      <StatusBar browserCount={snapshot.browsers.length} />
      {notice ? <NoticeToast notice={notice} onClose={() => setNotice(null)} /> : null}
    </div>
  );
}
