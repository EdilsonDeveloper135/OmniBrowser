import { Moon } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import {
  INTERACTIVE_ZOOM_THRESHOLD,
  MIN_BROWSER_HEIGHT,
  MIN_BROWSER_WIDTH,
  ZOOM_STEP
} from '../../shared/constants';
import {
  clampWorldRect,
  computeCanvasLayout,
  projectWorldRect,
  roundZoom,
  screenRectFullyInside,
  screenToWorld,
  snapRect,
  zoomAroundPoint
} from '../../shared/geometry';
import type { BrowserSnapshot, Camera, ProfileRecord, ScreenRect, WorkspaceSnapshot, WorldRect } from '../../shared/schemas';
import { displayDomain } from '../../shared/urls';
import { LayoutCommitter } from '../lib/layout-committer';
import { profileColor } from '../lib/profile-colors';
import type { ActiveInteraction } from '../lib/snapshot-merge';
import { BrowserCard, resizeWorldRect, type ResizeDirection } from './BrowserCard';
import { Minimap } from './Minimap';

const KEYBOARD_PAN_STEP = 40;
const KEYBOARD_PAN_LARGE_STEP = 200;
const SEMANTIC_FOCUS_ZOOM = 0.72;

interface WorkspaceCanvasProps {
  snapshot: WorkspaceSnapshot;
  noticeId: number | null;
  onUpdateBrowserRect: (browserId: string, rect: WorldRect) => void;
  onUpdateCamera: (update: (camera: Camera) => Camera) => void;
  onFocus: (browserId: string, options?: { focusContents?: boolean }) => Promise<void>;
  onClose: (browserId: string) => Promise<void>;
  onSleep: (browserId: string) => Promise<void>;
  onWake: (browserId: string) => Promise<void>;
  onReload: (browserId: string) => Promise<void>;
  onAssignProfile: (browserId: string, profileId: string) => Promise<void>;
  onInteractionChange: (interaction: ActiveInteraction) => void;
  onViewportChange: (size: { width: number; height: number }) => void;
}

function profileFor(profiles: ProfileRecord[], profileId: string): { profile?: ProfileRecord; index: number } {
  const index = profiles.findIndex((profile) => profile.id === profileId);
  return { profile: profiles[index], index };
}

function sameScreenRect(a: ScreenRect | null, b: ScreenRect | null): boolean {
  return a === b || (a !== null && b !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);
}

function logBridgeError(action: string) {
  return (error: unknown) => console.error(`[omnibrowser] No se pudo ${action}:`, error);
}

export function WorkspaceCanvas({ snapshot, noticeId, onUpdateBrowserRect, onUpdateCamera, onFocus, onClose, onSleep, onWake, onReload, onAssignProfile, onInteractionChange, onViewportChange }: WorkspaceCanvasProps) {
  const viewportRef = useRef<HTMLElement>(null);
  const [viewport, setViewport] = useState<ScreenRect | null>(null);
  const [noticeRect, setNoticeRect] = useState<ScreenRect | null>(null);
  const cameraRef = useRef(snapshot.camera);
  const viewportStateRef = useRef<ScreenRect | null>(null);
  const endGestureRef = useRef<(() => void) | null>(null);
  const committerRef = useRef<LayoutCommitter | null>(null);
  const callbacksRef = useRef({ onUpdateCamera, onInteractionChange, onViewportChange });
  const lowZoom = snapshot.camera.zoom < INTERACTIVE_ZOOM_THRESHOLD;

  // Gesture and wheel handlers outlive a render; they read the latest camera, viewport and callbacks through refs.
  useLayoutEffect(() => {
    cameraRef.current = snapshot.camera;
    viewportStateRef.current = viewport;
    callbacksRef.current = { onUpdateCamera, onInteractionChange, onViewportChange };
  });

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      const next = snapRect(rect.left, rect.top, rect.right, rect.bottom);
      setViewport((current) => sameScreenRect(current, next) ? current : next);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener('resize', measure);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  useEffect(() => {
    if (viewport) callbacksRef.current.onViewportChange({ width: viewport.width, height: viewport.height });
  }, [viewport]);

  // A visible notice is an overlay inside the canvas, so native views under it are hidden while it is shown.
  useLayoutEffect(() => {
    const rect = noticeId === null ? undefined : document.querySelector('.notice-toast')?.getBoundingClientRect();
    const next = rect ? snapRect(rect.left, rect.top, rect.right, rect.bottom) : null;
    setNoticeRect((current) => sameScreenRect(current, next) ? current : next);
  }, [noticeId, viewport]);

  const layout = useMemo(() => {
    if (!viewport) return null;
    const cards = snapshot.browsers.map((browser) => ({
      id: browser.id,
      worldRect: browser.worldRect,
      zIndex: browser.zIndex,
      suspended: browser.suspended,
      crashed: browser.runtime.crashed
    }));
    return computeCanvasLayout(cards, snapshot.camera, viewport, noticeRect ? [noticeRect] : []);
  }, [snapshot.browsers, snapshot.camera, viewport, noticeRect]);

  useEffect(() => {
    const committer = new LayoutCommitter((batch) => window.omniBrowser.workspace.commitLayout(batch), logBridgeError('aplicar el layout nativo'));
    committerRef.current = committer;
    return () => committer.dispose();
  }, []);

  useEffect(() => {
    if (layout) committerRef.current?.submit({ items: layout.items });
  }, [layout]);

  useEffect(() => {
    const timer = setTimeout(() => {
      window.omniBrowser.workspace.setCamera(snapshot.camera).catch(logBridgeError('guardar la cámara'));
    }, 120);
    return () => clearTimeout(timer);
  }, [snapshot.camera]);

  // React registers wheel listeners as passive, which silently ignores preventDefault(); this one must not be passive.
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        const rect = element.getBoundingClientRect();
        const pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        const factor = Math.exp(-event.deltaY * 0.006);
        callbacksRef.current.onUpdateCamera((camera) => zoomAroundPoint(camera, camera.zoom * factor, pointer));
        return;
      }
      callbacksRef.current.onUpdateCamera((camera) => ({ ...camera, panX: camera.panX - event.deltaX, panY: camera.panY - event.deltaY }));
    };
    element.addEventListener('wheel', handleWheel, { passive: false });
    return () => element.removeEventListener('wheel', handleWheel);
  }, []);

  useEffect(() => () => endGestureRef.current?.(), []);

  const beginGesture = (event: ReactPointerEvent<HTMLElement>, interaction: ActiveInteraction, onMove: (pointer: PointerEvent) => void) => {
    event.preventDefault();
    event.stopPropagation();
    endGestureRef.current?.();
    const { pointerId } = event;
    const target = event.currentTarget;
    // Real pointers are captured so moves and the final pointerup keep arriving outside the element or window.
    const captured = event.nativeEvent.isTrusted;
    if (captured) target.setPointerCapture(pointerId);
    const move = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return;
      // No pressed buttons means the pointerup was delivered somewhere this gesture could not observe.
      if (pointerEvent.buttons === 0) {
        end();
        return;
      }
      onMove(pointerEvent);
    };
    const release = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId === pointerId) end();
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      window.removeEventListener('blur', end);
      if (captured) {
        target.removeEventListener('lostpointercapture', end);
        if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
      }
      if (endGestureRef.current === end) {
        endGestureRef.current = null;
        callbacksRef.current.onInteractionChange(null);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    window.addEventListener('blur', end);
    if (captured) target.addEventListener('lostpointercapture', end);
    endGestureRef.current = end;
    callbacksRef.current.onInteractionChange(interaction);
  };

  const pointerInWorld = (pointer: { clientX: number; clientY: number }) => {
    const currentViewport = viewportStateRef.current;
    return currentViewport ? screenToWorld({ x: pointer.clientX, y: pointer.clientY }, cameraRef.current, currentViewport) : null;
  };

  const beginMove = (browser: BrowserSnapshot, event: ReactPointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest('button, select, input')) return;
    const startPointer = pointerInWorld(event);
    if (!startPointer) return;
    const startRect = browser.worldRect;
    void onFocus(browser.id, { focusContents: true });
    beginGesture(event, { kind: 'card', browserId: browser.id }, (pointer) => {
      const current = pointerInWorld(pointer);
      if (!current) return;
      onUpdateBrowserRect(browser.id, clampWorldRect({ ...startRect, x: startRect.x + current.x - startPointer.x, y: startRect.y + current.y - startPointer.y }));
    });
  };

  const beginResize = (browser: BrowserSnapshot, direction: ResizeDirection, event: ReactPointerEvent<HTMLElement>) => {
    const startPointer = pointerInWorld(event);
    if (!startPointer) return;
    const startRect = browser.worldRect;
    void onFocus(browser.id, { focusContents: true });
    beginGesture(event, { kind: 'card', browserId: browser.id }, (pointer) => {
      const current = pointerInWorld(pointer);
      if (!current) return;
      const resized = resizeWorldRect(startRect, direction, current.x - startPointer.x, current.y - startPointer.y, MIN_BROWSER_WIDTH, MIN_BROWSER_HEIGHT);
      onUpdateBrowserRect(browser.id, clampWorldRect(resized));
    });
  };

  const beginPan = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('.browser-card, .semantic-card, .minimap')) return;
    const start = { x: event.clientX, y: event.clientY };
    const startCamera = cameraRef.current;
    viewportRef.current?.focus({ preventScroll: true });
    beginGesture(event, { kind: 'canvas' }, (pointer) => {
      callbacksRef.current.onUpdateCamera((camera) => ({
        ...camera,
        panX: startCamera.panX + pointer.clientX - start.x,
        panY: startCamera.panY + pointer.clientY - start.y
      }));
    });
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget || !viewport || event.metaKey || event.ctrlKey || event.altKey) return;
    const step = event.shiftKey ? KEYBOARD_PAN_LARGE_STEP : KEYBOARD_PAN_STEP;
    const center = { x: viewport.width / 2, y: viewport.height / 2 };
    const pan = (dx: number, dy: number) => onUpdateCamera((camera) => ({ ...camera, panX: camera.panX + dx, panY: camera.panY + dy }));
    const zoomTo = (zoom: (current: number) => number) => onUpdateCamera((camera) => zoomAroundPoint(camera, roundZoom(zoom(camera.zoom)), center));
    switch (event.key) {
      case 'ArrowLeft': pan(step, 0); break;
      case 'ArrowRight': pan(-step, 0); break;
      case 'ArrowUp': pan(0, step); break;
      case 'ArrowDown': pan(0, -step); break;
      case '+':
      case '=': zoomTo((zoom) => zoom + ZOOM_STEP); break;
      case '-':
      case '_': zoomTo((zoom) => zoom - ZOOM_STEP); break;
      case '0': zoomTo(() => 1); break;
      default: return;
    }
    event.preventDefault();
  };

  const centerOn = (browser: BrowserSnapshot, zoom: number) => {
    if (!viewport) return;
    onUpdateCamera(() => ({
      zoom,
      panX: viewport.width / 2 - (browser.worldRect.x + browser.worldRect.width / 2) * zoom,
      panY: viewport.height / 2 - (browser.worldRect.y + browser.worldRect.height / 2) * zoom
    }));
  };

  const focusSemanticCard = (browser: BrowserSnapshot) => {
    centerOn(browser, SEMANTIC_FOCUS_ZOOM);
    void onFocus(browser.id);
  };

  const selectFromMinimap = (browserId: string) => {
    const browser = snapshot.browsers.find((candidate) => candidate.id === browserId);
    if (!browser) return;
    // Selecting a card that is not fully on screen brings it into view at the current zoom.
    if (viewport && !lowZoom && !screenRectFullyInside(projectWorldRect(browser.worldRect, snapshot.camera, viewport), viewport)) {
      centerOn(browser, snapshot.camera.zoom);
    }
    void onFocus(browser.id);
  };

  return (
    <main
      aria-label="Canvas de navegadores. Flechas para desplazar, más y menos para acercar o alejar."
      className="canvas-viewport"
      onKeyDown={handleKeyDown}
      onPointerDown={beginPan}
      ref={viewportRef}
      tabIndex={0}
    >
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
              onReload={() => void onReload(browser.id)}
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
        hidden={layout?.minimapCovered ?? false}
        onSelect={selectFromMinimap}
        selectedBrowserId={snapshot.selectedBrowserId}
        viewportSize={viewport ?? { width: 1, height: 1 }}
      />
      <div className="canvas-position">x {Math.round(-snapshot.camera.panX / snapshot.camera.zoom)} · y {Math.round(-snapshot.camera.panY / snapshot.camera.zoom)}</div>
    </main>
  );
}
