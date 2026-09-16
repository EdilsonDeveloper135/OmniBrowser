import { Moon } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';
import {
  INTERACTIVE_ZOOM_THRESHOLD,
  MAX_ZOOM,
  MIN_BROWSER_HEIGHT,
  MIN_BROWSER_WIDTH,
  MIN_ZOOM
} from '../../shared/constants';
import { clampZoom, screenRectFullyInside, screenDeltaToWorld, zoomAroundPoint } from '../../shared/geometry';
import type { BrowserSnapshot, Camera, ProfileRecord, ScreenRect, WorkspaceSnapshot, WorldRect } from '../../shared/schemas';
import { displayDomain } from '../../shared/urls';
import { profileColor } from '../lib/profile-colors';
import { BrowserCard, resizeWorldRect, type ResizeDirection } from './BrowserCard';
import { Minimap } from './Minimap';

interface WorkspaceCanvasProps {
  snapshot: WorkspaceSnapshot;
  onUpdateBrowserRect: (browserId: string, rect: WorldRect) => void;
  onUpdateCamera: (camera: Camera) => void;
  onFocus: (browserId: string) => Promise<void>;
  onClose: (browserId: string) => Promise<void>;
  onSleep: (browserId: string) => Promise<void>;
  onWake: (browserId: string) => Promise<void>;
  onAssignProfile: (browserId: string, profileId: string) => Promise<void>;
}

function profileFor(profiles: ProfileRecord[], profileId: string): { profile?: ProfileRecord; index: number } {
  const index = profiles.findIndex((profile) => profile.id === profileId);
  return { profile: profiles[index], index };
}

export function WorkspaceCanvas({ snapshot, onUpdateBrowserRect, onUpdateCamera, onFocus, onClose, onSleep, onWake, onAssignProfile }: WorkspaceCanvasProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewportSize, setViewportSize] = useState({ width: 1, height: 1 });
  const lowZoom = snapshot.camera.zoom < INTERACTIVE_ZOOM_THRESHOLD;

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setViewportSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const animationFrame = requestAnimationFrame(() => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const viewportRect = viewport.getBoundingClientRect();
      const safeViewport: ScreenRect = {
        x: Math.round(viewportRect.left),
        y: Math.round(viewportRect.top),
        width: Math.max(1, Math.round(viewportRect.width)),
        height: Math.max(1, Math.round(viewportRect.height))
      };
      const items = snapshot.browsers.map((browser) => {
        const element = document.querySelector<HTMLElement>(`[data-browser-content="${browser.id}"]`);
        const rect = element?.getBoundingClientRect();
        const screenBounds: ScreenRect = rect ? {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.max(1, Math.round(rect.width)),
          height: Math.max(1, Math.round(rect.height))
        } : { x: safeViewport.x, y: safeViewport.y, width: 1, height: 1 };
        return {
          browserId: browser.id,
          worldRect: browser.worldRect,
          zIndex: browser.zIndex,
          screenBounds,
          visible: Boolean(rect)
            && !browser.suspended
            && snapshot.camera.zoom >= INTERACTIVE_ZOOM_THRESHOLD
            && screenRectFullyInside(screenBounds, safeViewport)
        };
      });
      void window.omniBrowser.workspace.commitLayout({ items });
    });
    return () => cancelAnimationFrame(animationFrame);
  }, [snapshot.browsers, snapshot.camera.zoom, snapshot.selectedBrowserId]);

  useEffect(() => {
    const timer = setTimeout(() => void window.omniBrowser.workspace.setCamera(snapshot.camera), 120);
    return () => clearTimeout(timer);
  }, [snapshot.camera]);

  const updateFromPointer = (
    event: ReactPointerEvent<HTMLElement>,
    onMove: (delta: { x: number; y: number }) => void
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const start = { x: event.clientX, y: event.clientY };
    const move = (pointerEvent: PointerEvent) => onMove({ x: pointerEvent.clientX - start.x, y: pointerEvent.clientY - start.y });
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', cleanup);
      window.removeEventListener('pointercancel', cleanup);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', cleanup, { once: true });
    window.addEventListener('pointercancel', cleanup, { once: true });
  };

  const beginMove = (browser: BrowserSnapshot, event: ReactPointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest('button, select, input')) return;
    const startRect = browser.worldRect;
    void onFocus(browser.id);
    updateFromPointer(event, (delta) => {
      const worldDelta = screenDeltaToWorld(delta, snapshot.camera.zoom);
      onUpdateBrowserRect(browser.id, { ...startRect, x: startRect.x + worldDelta.x, y: startRect.y + worldDelta.y });
    });
  };

  const beginResize = (browser: BrowserSnapshot, direction: ResizeDirection, event: ReactPointerEvent<HTMLElement>) => {
    const startRect = browser.worldRect;
    void onFocus(browser.id);
    updateFromPointer(event, (delta) => {
      const worldDelta = screenDeltaToWorld(delta, snapshot.camera.zoom);
      onUpdateBrowserRect(browser.id, resizeWorldRect(startRect, direction, worldDelta.x, worldDelta.y, MIN_BROWSER_WIDTH, MIN_BROWSER_HEIGHT));
    });
  };

  const beginPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('.browser-card, .semantic-card, .minimap')) return;
    const startCamera = snapshot.camera;
    updateFromPointer(event, (delta) => onUpdateCamera({ ...startCamera, panX: startCamera.panX + delta.x, panY: startCamera.panY + delta.y }));
  };

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      const viewport = viewportRef.current?.getBoundingClientRect();
      if (!viewport) return;
      const factor = Math.exp(-event.deltaY * 0.006);
      onUpdateCamera(zoomAroundPoint(snapshot.camera, snapshot.camera.zoom * factor, {
        x: event.clientX - viewport.left,
        y: event.clientY - viewport.top
      }));
      return;
    }
    onUpdateCamera({ ...snapshot.camera, panX: snapshot.camera.panX - event.deltaX, panY: snapshot.camera.panY - event.deltaY });
  };

  const focusSemanticCard = (browser: BrowserSnapshot) => {
    const zoom = 0.72;
    onUpdateCamera({
      zoom,
      panX: viewportSize.width / 2 - (browser.worldRect.x + browser.worldRect.width / 2) * zoom,
      panY: viewportSize.height / 2 - (browser.worldRect.y + browser.worldRect.height / 2) * zoom
    });
    void onFocus(browser.id);
  };

  return (
    <main className="canvas-viewport" onPointerDown={beginPan} onWheel={handleWheel} ref={viewportRef}>
      <div className="canvas-grid" style={{ backgroundPosition: `${snapshot.camera.panX}px ${snapshot.camera.panY}px`, backgroundSize: `${24 * snapshot.camera.zoom}px ${24 * snapshot.camera.zoom}px` }} />
      {!lowZoom ? (
        <div className="canvas-world" style={{ transform: `translate(${snapshot.camera.panX}px, ${snapshot.camera.panY}px) scale(${snapshot.camera.zoom})` }}>
          {snapshot.browsers.map((browser) => (
            <BrowserCard
              browser={browser}
              key={browser.id}
              onAssignProfile={(profileId) => void onAssignProfile(browser.id, profileId)}
              onBeginMove={(event) => beginMove(browser, event)}
              onBeginResize={(direction, event) => beginResize(browser, direction, event)}
              onClose={() => void onClose(browser.id)}
              onFocus={() => void onFocus(browser.id)}
              onSleep={() => void onSleep(browser.id)}
              onWake={() => void onWake(browser.id)}
              profiles={snapshot.profiles}
              selected={snapshot.selectedBrowserId === browser.id}
            />
          ))}
        </div>
      ) : (
        <div className="semantic-layer">
          {snapshot.browsers.map((browser) => {
            const { profile, index } = profileFor(snapshot.profiles, browser.profileId);
            if (!profile) return null;
            return (
              <button
                className={`semantic-card ${snapshot.selectedBrowserId === browser.id ? 'is-selected' : ''}`}
                key={browser.id}
                onClick={() => focusSemanticCard(browser)}
                style={{
                  left: snapshot.camera.panX + browser.worldRect.x * snapshot.camera.zoom,
                  top: snapshot.camera.panY + browser.worldRect.y * snapshot.camera.zoom,
                  zIndex: browser.zIndex,
                  '--profile-color': profileColor(profile, index)
                } as React.CSSProperties}
                type="button"
              >
                <span className="semantic-icon">{browser.suspended ? <Moon size={18} /> : <span />}</span>
                <strong>{browser.title}</strong>
                <small>{displayDomain(browser.url)} · {profile.name}</small>
              </button>
            );
          })}
        </div>
      )}
      <Minimap
        browsers={snapshot.browsers}
        camera={snapshot.camera}
        onSelect={(browserId) => void onFocus(browserId)}
        selectedBrowserId={snapshot.selectedBrowserId}
        viewportSize={viewportSize}
      />
      <div className="canvas-position">x {Math.round(-snapshot.camera.panX / snapshot.camera.zoom)} · y {Math.round(-snapshot.camera.panY / snapshot.camera.zoom)}</div>
    </main>
  );
}

export function nextZoom(current: number, delta: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, clampZoom(current + delta)));
}
