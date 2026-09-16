import { LoaderCircle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { clampZoom } from '../shared/geometry';
import type { OmniEvent } from '../shared/contracts';
import type { BrowserSnapshot, Camera, ProfileRecord, WorkspaceSnapshot, WorldRect } from '../shared/schemas';
import { ProfileRail } from './components/ProfileRail';
import { Toolbar } from './components/Toolbar';
import { WorkspaceCanvas } from './components/WorkspaceCanvas';
import { StatusBar } from './components/StatusBar';
import { NoticeToast, type NoticeState } from './components/NoticeToast';
import { userFacingError } from './lib/errors';

export function App() {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);

  const pushNotice = (level: NoticeState['level'], message: string) => {
    const next = { id: Date.now(), level, message };
    setNotice(next);
    window.setTimeout(() => setNotice((current) => current?.id === next.id ? null : current), 5000);
  };

  useEffect(() => {
    let active = true;
    const unsubscribe = window.omniBrowser.events.subscribe((event: OmniEvent) => {
      if (!active) return;
      if (event.type === 'workspace-snapshot') setSnapshot(event.snapshot);
      if (event.type === 'browser-state') {
        setSnapshot((current) => current ? {
          ...current,
          browsers: current.browsers.map((browser) => browser.id === event.browser.id ? event.browser : browser)
        } : current);
      }
      if (event.type === 'save-status') setSnapshot((current) => current ? { ...current, saveStatus: event.status } : current);
      if (event.type === 'notice') pushNotice(event.level, event.message);
    });
    window.omniBrowser.bootstrap().then((initial) => {
      if (!active) return;
      setSnapshot(initial);
      const selected = initial.browsers.find((browser) => browser.id === initial.selectedBrowserId);
      setActiveProfileId(selected?.profileId ?? initial.profiles[0]?.id ?? null);
    }).catch((error: unknown) => {
      if (active) setFatalError(error instanceof Error ? error.message : String(error));
    });
    return () => { active = false; unsubscribe(); };
  }, []);

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

  const updateCamera = (camera: Camera) => setSnapshot((current) => current ? { ...current, camera: { ...camera, zoom: clampZoom(camera.zoom) } } : current);
  const applySnapshot = (next: WorkspaceSnapshot) => setSnapshot(next);
  const focus = async (browserId: string) => {
    setSnapshot((current) => {
      if (!current) return current;
      const highest = Math.max(0, ...current.browsers.map((browser) => browser.zIndex));
      return {
        ...current,
        selectedBrowserId: browserId,
        browsers: current.browsers.map((browser) => browser.id === browserId
          ? { ...browser, zIndex: browser.zIndex === highest ? browser.zIndex : highest + 1 }
          : browser)
      };
    });
    await run(() => window.omniBrowser.browsers.focus(browserId));
  };

  const createProfile = async (name: string, kind: ProfileRecord['kind']) => {
    const next = await run(
      () => kind === 'persistent' ? window.omniBrowser.profiles.createPersistent(name) : window.omniBrowser.profiles.createTemporary(name),
      applySnapshot
    );
    const created = next?.profiles.at(-1);
    if (created) setActiveProfileId(created.id);
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
        onZoom={(zoom) => updateCamera({ ...snapshot.camera, zoom })}
        saveStatus={snapshot.saveStatus}
        zoom={snapshot.camera.zoom}
      />
      <WorkspaceCanvas
        onAssignProfile={(browserId, profileId) => run(() => window.omniBrowser.browsers.assignProfile(browserId, profileId), applySnapshot).then(() => undefined)}
        onClose={(browserId) => run(() => window.omniBrowser.browsers.close(browserId), applySnapshot).then(() => undefined)}
        onFocus={focus}
        onSleep={(browserId) => run(() => window.omniBrowser.browsers.sleep(browserId), applySnapshot).then(() => undefined)}
        onUpdateBrowserRect={updateBrowserRect}
        onUpdateCamera={updateCamera}
        onWake={(browserId) => run(() => window.omniBrowser.browsers.wake(browserId), applySnapshot).then(() => undefined)}
        snapshot={snapshot}
      />
      <StatusBar browserCount={snapshot.browsers.length} />
      {notice ? <NoticeToast notice={notice} onClose={() => setNotice(null)} /> : null}
    </div>
  );
}
