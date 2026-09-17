import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Copy,
  Layers3,
  Lock,
  Minimize2,
  Moon,
  Pin,
  Unlock,
  X
} from 'lucide-react';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from 'react';
import {
  CARD_BORDER_WIDTH,
  CARD_CONTENT_INSET,
  INTERACTIVE_ZOOM_THRESHOLD,
  MIN_BROWSER_HEIGHT,
  MIN_BROWSER_WIDTH,
  MINIMIZED_BROWSER_HEIGHT,
  MINIMIZED_BROWSER_WIDTH,
  ZONE_PADDING,
  ZOOM_STEP
} from '../../shared/constants';
import {
  boundsForWorldRects,
  clampWorldRect,
  computeCanvasLayout,
  projectCardChrome,
  projectWorldArea,
  roundZoom,
  screenAreaToWorld,
  screenToWorld,
  snapMovedWorldRect,
  snapRect,
  snapResizedWorldRect,
  zoomAroundPoint,
  type SnapGuide,
  type WorldArea
} from '../../shared/geometry';
import type {
  BrowserSnapshot,
  Camera,
  NormalizedViewportRect,
  ScreenRect,
  WorkspaceSnapshot,
  WorldRect,
  ZoneRecord
} from '../../shared/schemas';
import { displayDomain } from '../../shared/urls';
import { LayoutCommitter } from '../lib/layout-committer';
import { profileColor } from '../lib/profile-colors';
import type { ActiveInteraction } from '../lib/snapshot-merge';
import { BrowserCard, resizeWorldRect, type BrowserCardActions, type ResizeDirection } from './BrowserCard';
import { Minimap } from './Minimap';

const KEYBOARD_PAN_STEP = 40;
const KEYBOARD_PAN_LARGE_STEP = 200;
const SEMANTIC_FOCUS_ZOOM = 0.72;
const LOCATE_MARGIN = 80;
const NO_BROWSERS: BrowserSnapshot[] = [];

export interface LocateRequest {
  browserId: string;
  token: number;
}

interface WorkspaceCanvasProps {
  snapshot: WorkspaceSnapshot;
  noticeId: number | null;
  selectedBrowserIds: ReadonlySet<string>;
  fullscreenBrowserId: string | null;
  locateRequest: LocateRequest | null;
  onSelectionChange: (ids: Set<string>) => void;
  onFullscreenChange: (browserId: string | null) => void;
  onUpdateBrowserRects: (rects: Map<string, WorldRect>) => void;
  onUpdateCamera: (update: (camera: Camera) => Camera) => void;
  onFocus: (browserId: string, options?: { focusContents?: boolean }) => Promise<void>;
  onClearFocus: () => Promise<void>;
  onClose: (browserId: string) => Promise<void>;
  onSleep: (browserId: string) => Promise<void>;
  onWake: (browserId: string) => Promise<void>;
  onReload: (browserId: string) => Promise<void>;
  onStop: (browserId: string) => Promise<void>;
  onBack: (browserId: string) => Promise<void>;
  onForward: (browserId: string) => Promise<void>;
  onNavigate: (browserId: string, url: string) => Promise<void>;
  onAssignProfile: (browserId: string, profileId: string) => Promise<void>;
  onSetPresentation: (browserIds: string[], presentation: 'normal' | 'minimized') => Promise<void>;
  onSetLocked: (browserIds: string[], locked: boolean) => Promise<void>;
  onSetSidebarPinned: (browserIds: string[], pinned: boolean) => Promise<void>;
  onSetViewportPin: (browserId: string, viewport: NormalizedViewportRect | null) => Promise<void>;
  onDuplicate: (browserIds: string[]) => Promise<void>;
  onCreateZone: (browserIds: string[]) => Promise<void>;
  onSetZoneCollapsed: (zone: ZoneRecord, collapsed: boolean) => Promise<void>;
  onCreateStack: (zoneId: string, browserIds: string[]) => Promise<void>;
  onSelectStackMember: (stackId: string, browserId: string) => Promise<void>;
  onUnstack: (stackId: string) => Promise<void>;
  onInteractionChange: (interaction: ActiveInteraction) => void;
  onViewportChange: (size: { width: number; height: number }) => void;
}

function sameScreenRect(a: ScreenRect | null, b: ScreenRect | null): boolean {
  return a === b || (a !== null && b !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);
}

function sameScreenRects(a: readonly ScreenRect[], b: readonly ScreenRect[]): boolean {
  return a.length === b.length && a.every((rect, index) => sameScreenRect(rect, b[index] ?? null));
}

function sameWorldAreas(a: readonly WorldArea[], b: readonly WorldArea[]): boolean {
  const close = (left: number, right: number) => Math.abs(left - right) < 0.01;
  return a.length === b.length && a.every((area, index) => {
    const other = b[index];
    return other !== undefined && close(area.x, other.x) && close(area.y, other.y) && close(area.width, other.width) && close(area.height, other.height);
  });
}

/**
 * Returns the previous browser list while only runtime state (titles, loading, audio, favicons) changed, so work that
 * depends on where cards are drawn — measuring overlays forces a synchronous layout — does not repeat for every page
 * event. Snapshot merges keep the geometry objects of unchanged browsers, so reference checks are enough.
 */
function useStableGeometry(browsers: readonly BrowserSnapshot[]): readonly BrowserSnapshot[] {
  const previous = useRef(browsers);
  const current = previous.current;
  const unchanged = current.length === browsers.length && browsers.every((browser, index) => {
    const before = current[index]!;
    return before === browser || (before.id === browser.id
      && before.worldRect === browser.worldRect
      && before.presentation === browser.presentation
      && before.pin === browser.pin
      && before.zoneId === browser.zoneId);
  });
  if (!unchanged) previous.current = browsers;
  return previous.current;
}

interface Occluders {
  /** Overlays fixed to the viewport, such as notices and the selection toolbar. */
  screen: ScreenRect[];
  /** Overlays drawn inside the canvas world, such as zone labels and card menus, which move with the camera. */
  world: WorldArea[];
}

function visualRect(browser: BrowserSnapshot): WorldRect {
  return browser.presentation === 'minimized'
    ? { ...browser.worldRect, width: MINIMIZED_BROWSER_WIDTH, height: MINIMIZED_BROWSER_HEIGHT }
    : browser.worldRect;
}

function screenContentBounds(outer: ScreenRect): ScreenRect {
  return snapRect(
    outer.x + CARD_BORDER_WIDTH + CARD_CONTENT_INSET.left,
    outer.y + CARD_BORDER_WIDTH + CARD_CONTENT_INSET.top,
    outer.x + outer.width - CARD_BORDER_WIDTH - CARD_CONTENT_INSET.right,
    outer.y + outer.height - CARD_BORDER_WIDTH - CARD_CONTENT_INSET.bottom
  );
}

function rectIntersects(a: WorldRect, b: WorldRect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function logBridgeError(action: string) {
  return (error: unknown) => console.error(`[omnibrowser] No se pudo ${action}:`, error);
}

export function WorkspaceCanvas(props: WorkspaceCanvasProps) {
  const {
    snapshot,
    noticeId,
    selectedBrowserIds,
    fullscreenBrowserId,
    locateRequest,
    onSelectionChange,
    onFullscreenChange,
    onUpdateBrowserRects,
    onUpdateCamera,
    onFocus,
    onClearFocus,
    onClose,
    onSleep,
    onWake,
    onReload,
    onStop,
    onBack,
    onForward,
    onNavigate,
    onAssignProfile,
    onSetPresentation,
    onSetLocked,
    onSetSidebarPinned,
    onSetViewportPin,
    onDuplicate,
    onCreateZone,
    onSetZoneCollapsed,
    onCreateStack,
    onSelectStackMember,
    onUnstack,
    onInteractionChange,
    onViewportChange
  } = props;
  const viewportRef = useRef<HTMLElement>(null);
  const [viewport, setViewport] = useState<ScreenRect | null>(null);
  const [occluders, setOccluders] = useState<Occluders>({ screen: [], world: [] });
  const [marquee, setMarquee] = useState<{ start: { x: number; y: number }; current: { x: number; y: number } } | null>(null);
  const [snapGuides, setSnapGuides] = useState<SnapGuide[]>([]);
  const [menuBrowserId, setMenuBrowserId] = useState<string | null>(null);
  const cameraRef = useRef(snapshot.camera);
  const viewportStateRef = useRef<ScreenRect | null>(null);
  const endGestureRef = useRef<(() => void) | null>(null);
  const committerRef = useRef<LayoutCommitter | null>(null);
  const callbacksRef = useRef({ onUpdateCamera, onInteractionChange, onViewportChange });
  const handledLocateToken = useRef<number | null>(null);
  const spaceHeldRef = useRef(false);
  const lowZoom = snapshot.camera.zoom < INTERACTIVE_ZOOM_THRESHOLD;

  const browserById = useMemo(() => new Map(snapshot.browsers.map((browser) => [browser.id, browser])), [snapshot.browsers]);
  const zoneById = useMemo(() => new Map(snapshot.zones.map((zone) => [zone.id, zone])), [snapshot.zones]);
  const stackByBrowser = useMemo(() => new Map(snapshot.stacks.flatMap((stack) => stack.browserIds.map((id) => [id, stack] as const))), [snapshot.stacks]);
  const topStackBrowserIds = useMemo(() => new Set(snapshot.stacks.map((stack) => stack.browserIds.at(-1)).filter((id): id is string => Boolean(id))), [snapshot.stacks]);
  const browsersByZone = useMemo(() => {
    const result = new Map<string, BrowserSnapshot[]>();
    for (const browser of snapshot.browsers) {
      if (!browser.zoneId) continue;
      const members = result.get(browser.zoneId);
      if (members) members.push(browser); else result.set(browser.zoneId, [browser]);
    }
    return result;
  }, [snapshot.browsers]);
  const profileById = useMemo(() => new Map(snapshot.profiles.map((profile, index) => [profile.id, { profile, index }])), [snapshot.profiles]);
  const cardGeometry = useStableGeometry(snapshot.browsers);

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

  useLayoutEffect(() => {
    const screen: ScreenRect[] = [];
    const world: WorldArea[] = [];
    for (const element of document.querySelectorAll<HTMLElement>('.notice-toast, .native-occluder')) {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      // The DOM transform of this commit matches snapshot.camera, so world overlays convert exactly. Keeping them in
      // world units means a pan or zoom reprojects them instead of leaving them at their previous screen position.
      if (viewport && element.closest('.canvas-world')) world.push(screenAreaToWorld(rect, snapshot.camera, viewport));
      else screen.push(snapRect(rect.left, rect.top, rect.right, rect.bottom));
    }
    setOccluders((current) => sameScreenRects(current.screen, screen) && sameWorldAreas(current.world, world) ? current : { screen, world });
  // Overlays are the notice, the selection toolbar, zone labels and chips and the selected card's menu: they only move
  // or appear when geometry, zones, stacks, the selection, the menu, full screen or the semantic threshold change.
  }, [noticeId, viewport, selectedBrowserIds, snapshot.selectedBrowserId, fullscreenBrowserId, menuBrowserId, lowZoom, cardGeometry, snapshot.zones, snapshot.stacks]);

  const outerScreenRectFor = (browser: BrowserSnapshot): ScreenRect | null => {
    if (!viewport) return null;
    if (fullscreenBrowserId === browser.id) return { ...viewport };
    const pin = browser.pin.viewport;
    if (pin) return snapRect(
      viewport.x + pin.x * viewport.width,
      viewport.y + pin.y * viewport.height,
      viewport.x + (pin.x + pin.width) * viewport.width,
      viewport.y + (pin.y + pin.height) * viewport.height
    );
    const rect = visualRect(browser);
    const projected = projectCardChrome(rect, snapshot.camera, { x: viewport.x, y: viewport.y });
    return snapRect(projected.x, projected.y, projected.x + projected.width, projected.y + projected.height);
  };

  const layout = useMemo(() => {
    if (!viewport) return null;
    const cards = snapshot.browsers.map((browser) => {
      const zone = browser.zoneId ? zoneById.get(browser.zoneId) : undefined;
      const stack = stackByBrowser.get(browser.id);
      const stackHidden = Boolean(stack && !topStackBrowserIds.has(browser.id));
      const globallyHidden = fullscreenBrowserId !== null && fullscreenBrowserId !== browser.id;
      const nativeHidden = globallyHidden || Boolean(zone?.collapsed) || stackHidden || browser.presentation === 'minimized' || menuBrowserId === browser.id;
      const chromeHidden = globallyHidden || Boolean(zone?.collapsed) || stackHidden;
      const outer = outerScreenRectFor(browser);
      const direct = browser.pin.viewport !== null || fullscreenBrowserId === browser.id;
      return {
        id: browser.id,
        worldRect: browser.worldRect,
        zIndex: browser.zIndex,
        suspended: browser.suspended,
        crashed: browser.runtime.crashed,
        nativeHidden,
        chromeHidden,
        surfaceLayer: fullscreenBrowserId === browser.id ? 'immersive' as const : browser.pin.viewport ? 'pinned' as const : 'normal' as const,
        screenContentBounds: direct && outer ? screenContentBounds(outer) : undefined,
        screenChromeBounds: (direct || browser.presentation === 'minimized') && outer ? outer : undefined
      };
    });
    const origin = { x: viewport.x, y: viewport.y };
    const occluderRects = [...occluders.screen, ...occluders.world.map((area) => projectWorldArea(area, snapshot.camera, origin))];
    return computeCanvasLayout(cards, snapshot.camera, viewport, occluderRects);
  }, [snapshot.browsers, snapshot.camera, viewport, occluders, zoneById, stackByBrowser, topStackBrowserIds, fullscreenBrowserId, menuBrowserId]);

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

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.code === 'Space' && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLSelectElement)) spaceHeldRef.current = true;
      if (event.key === 'Escape' && fullscreenBrowserId) onFullscreenChange(null);
    };
    const up = (event: KeyboardEvent) => { if (event.code === 'Space') spaceHeldRef.current = false; };
    const blur = () => { spaceHeldRef.current = false; };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, [fullscreenBrowserId, onFullscreenChange]);

  useEffect(() => () => endGestureRef.current?.(), []);

  const beginGesture = (
    event: ReactPointerEvent<HTMLElement>,
    interaction: ActiveInteraction,
    onMove: (pointer: PointerEvent) => void,
    onEnd?: () => void
  ) => {
    event.preventDefault();
    event.stopPropagation();
    endGestureRef.current?.();
    const { pointerId } = event;
    const target = event.currentTarget;
    const captured = event.nativeEvent.isTrusted;
    if (captured) target.setPointerCapture(pointerId);
    const move = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return;
      if (pointerEvent.buttons === 0) { end(); return; }
      onMove(pointerEvent);
    };
    const release = (pointerEvent: PointerEvent) => { if (pointerEvent.pointerId === pointerId) end(); };
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
        setSnapGuides([]);
        callbacksRef.current.onInteractionChange(null);
        onEnd?.();
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

  const expandedTransformIds = (seedIds: readonly string[]): string[] => {
    const result = new Set(seedIds);
    for (const id of seedIds) {
      const stack = stackByBrowser.get(id);
      for (const member of stack?.browserIds ?? []) result.add(member);
    }
    return [...result];
  };

  const selectedBrowsers = snapshot.browsers.filter((browser) => selectedBrowserIds.has(browser.id));
  const selectedIds = selectedBrowsers.map((browser) => browser.id);
  const selectedTransformIds = expandedTransformIds(selectedIds);
  const selectedTransformBrowsers = selectedTransformIds.map((id) => browserById.get(id)).filter((browser): browser is BrowserSnapshot => Boolean(browser));
  const selectionCanTransform = selectedTransformBrowsers.length > 0 && selectedTransformBrowsers.every((browser) =>
    !browser.positionLocked && !browser.pin.viewport && browser.presentation === 'normal' && !zoneById.get(browser.zoneId ?? '')?.collapsed
  );

  const selectCard = (browser: BrowserSnapshot, event: ReactPointerEvent<HTMLElement>, preserveSelection = false) => {
    if (event.shiftKey) {
      const next = new Set(selectedBrowserIds);
      if (next.has(browser.id)) next.delete(browser.id); else next.add(browser.id);
      onSelectionChange(next);
    } else if (!preserveSelection || !selectedBrowserIds.has(browser.id)) {
      onSelectionChange(new Set([browser.id]));
    }
    void onFocus(browser.id, { focusContents: true });
  };

  const beginMove = (browser: BrowserSnapshot, event: ReactPointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest('button, select, input, summary, details')) return;
    if (spaceHeldRef.current) { beginPan(event, true); return; }
    if (event.shiftKey) {
      selectCard(browser, event);
      event.stopPropagation();
      return;
    }
    const candidateIds = selectedBrowserIds.has(browser.id) && selectedBrowserIds.size > 1 ? [...selectedBrowserIds] : [browser.id];
    const ids = expandedTransformIds(candidateIds);
    const idSet = new Set(ids);
    const browsers = ids.map((id) => browserById.get(id)).filter((candidate): candidate is BrowserSnapshot => Boolean(candidate));
    if (browsers.some((candidate) => candidate.positionLocked || candidate.pin.viewport || zoneById.get(candidate.zoneId ?? '')?.collapsed)) {
      selectCard(browser, event, true);
      event.stopPropagation();
      return;
    }
    const startPointer = pointerInWorld(event);
    if (!startPointer) return;
    const starts = new Map(browsers.map((candidate) => [candidate.id, candidate.worldRect]));
    const bounding = boundsForWorldRects(browsers.map(visualRect));
    const snapTargets = snapshot.browsers.filter((candidate) => !idSet.has(candidate.id) && !candidate.pin.viewport && !zoneById.get(candidate.zoneId ?? '')?.collapsed).map(visualRect);
    selectCard(browser, event, true);
    beginGesture(event, { kind: 'cards', browserIds: ids }, (pointer) => {
      const current = pointerInWorld(pointer);
      if (!current) return;
      let dx = current.x - startPointer.x;
      let dy = current.y - startPointer.y;
      if (snapshot.preferences.snapEnabled && bounding) {
        const snapped = snapMovedWorldRect({ ...bounding, x: bounding.x + dx, y: bounding.y + dy }, snapTargets, cameraRef.current.zoom);
        dx += snapped.rect.x - (bounding.x + dx);
        dy += snapped.rect.y - (bounding.y + dy);
        setSnapGuides(snapped.guides);
      }
      onUpdateBrowserRects(new Map(browsers.map((candidate) => {
        const start = starts.get(candidate.id)!;
        return [candidate.id, clampWorldRect({ ...start, x: start.x + dx, y: start.y + dy })];
      })));
    });
  };

  const beginResize = (browser: BrowserSnapshot, direction: ResizeDirection, event: ReactPointerEvent<HTMLElement>) => {
    const stack = stackByBrowser.get(browser.id);
    const ids = stack?.browserIds ?? [browser.id];
    const idSet = new Set(ids);
    const browsers = ids.map((id) => browserById.get(id)).filter((candidate): candidate is BrowserSnapshot => Boolean(candidate));
    if (browsers.some((candidate) => candidate.positionLocked || candidate.pin.viewport)) return;
    const startPointer = pointerInWorld(event);
    if (!startPointer) return;
    const startRect = browser.worldRect;
    const snapTargets = snapshot.browsers.filter((candidate) => !idSet.has(candidate.id) && !candidate.pin.viewport && !zoneById.get(candidate.zoneId ?? '')?.collapsed).map(visualRect);
    selectCard(browser, event, true);
    beginGesture(event, { kind: 'cards', browserIds: ids }, (pointer) => {
      const current = pointerInWorld(pointer);
      if (!current) return;
      let resized = resizeWorldRect(startRect, direction, current.x - startPointer.x, current.y - startPointer.y, MIN_BROWSER_WIDTH, MIN_BROWSER_HEIGHT);
      if (snapshot.preferences.snapEnabled) {
        const snapped = snapResizedWorldRect(resized, direction, snapTargets, cameraRef.current.zoom);
        resized = snapped.rect;
        setSnapGuides(snapped.guides);
      }
      resized = clampWorldRect(resized);
      onUpdateBrowserRects(new Map(ids.map((id) => [id, resized])));
    });
  };

  const selectionBounds = boundsForWorldRects(selectedTransformBrowsers.map((browser) => browser.worldRect));
  const beginGroupResize = (direction: ResizeDirection, event: ReactPointerEvent<HTMLElement>) => {
    if (!selectionCanTransform || !selectionBounds || selectedTransformBrowsers.length < 2) return;
    const startPointer = pointerInWorld(event);
    if (!startPointer) return;
    const starts = new Map(selectedTransformBrowsers.map((browser) => [browser.id, browser.worldRect]));
    const minimumScaleX = Math.max(...selectedTransformBrowsers.map((browser) => MIN_BROWSER_WIDTH / browser.worldRect.width));
    const minimumScaleY = Math.max(...selectedTransformBrowsers.map((browser) => MIN_BROWSER_HEIGHT / browser.worldRect.height));
    beginGesture(event, { kind: 'cards', browserIds: selectedTransformIds }, (pointer) => {
      const current = pointerInWorld(pointer);
      if (!current) return;
      const raw = resizeWorldRect(selectionBounds, direction, current.x - startPointer.x, current.y - startPointer.y, selectionBounds.width * minimumScaleX, selectionBounds.height * minimumScaleY);
      const scaleX = raw.width / selectionBounds.width;
      const scaleY = raw.height / selectionBounds.height;
      const updates = new Map<string, WorldRect>();
      for (const browser of selectedTransformBrowsers) {
        const start = starts.get(browser.id)!;
        updates.set(browser.id, clampWorldRect({
          x: raw.x + (start.x - selectionBounds.x) * scaleX,
          y: raw.y + (start.y - selectionBounds.y) * scaleY,
          width: start.width * scaleX,
          height: start.height * scaleY
        }));
      }
      onUpdateBrowserRects(updates);
    });
  };

  const beginPan = (event: ReactPointerEvent<HTMLElement>, force = false) => {
    if (event.button !== 0) return;
    if (!force && (event.target as HTMLElement).closest('.browser-card, .semantic-card, .minimap, button, input, select')) return;
    if (event.shiftKey && !force) {
      const startWorld = pointerInWorld(event);
      if (!startWorld) return;
      setMarquee({ start: startWorld, current: startWorld });
      beginGesture(event, { kind: 'cards', browserIds: [] }, (pointer) => {
        const current = pointerInWorld(pointer);
        if (current) setMarquee({ start: startWorld, current });
      }, () => {
        setMarquee((current) => {
          if (current) {
            const rect = {
              x: Math.min(current.start.x, current.current.x),
              y: Math.min(current.start.y, current.current.y),
              width: Math.abs(current.current.x - current.start.x),
              height: Math.abs(current.current.y - current.start.y)
            };
            onSelectionChange(new Set(snapshot.browsers.filter((browser) => !browser.pin.viewport && !zoneById.get(browser.zoneId ?? '')?.collapsed && rectIntersects(rect, visualRect(browser))).map((browser) => browser.id)));
          }
          return null;
        });
      });
      return;
    }
    const start = { x: event.clientX, y: event.clientY };
    const startCamera = cameraRef.current;
    viewportRef.current?.focus({ preventScroll: true });
    onSelectionChange(new Set());
    void onClearFocus();
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
    const rect = visualRect(browser);
    onUpdateCamera(() => ({
      zoom,
      panX: viewport.width / 2 - (rect.x + rect.width / 2) * zoom,
      panY: viewport.height / 2 - (rect.y + rect.height / 2) * zoom
    }));
  };

  useEffect(() => {
    if (!locateRequest || handledLocateToken.current === locateRequest.token || !viewport) return;
    const browser = browserById.get(locateRequest.browserId);
    if (!browser) { handledLocateToken.current = locateRequest.token; return; }
    const zone = browser.zoneId ? zoneById.get(browser.zoneId) : undefined;
    if (zone?.collapsed) {
      void onSetZoneCollapsed(zone, false);
      return;
    }
    const stack = stackByBrowser.get(browser.id);
    if (stack && stack.browserIds.at(-1) !== browser.id) {
      void onSelectStackMember(stack.id, browser.id);
      return;
    }
    handledLocateToken.current = locateRequest.token;
    onSelectionChange(new Set([browser.id]));
    void onFocus(browser.id);
    if (!browser.pin.viewport) {
      const rect = visualRect(browser);
      const zoom = Math.min(1, Math.max(INTERACTIVE_ZOOM_THRESHOLD,
        Math.min((viewport.width - LOCATE_MARGIN * 2) / rect.width, (viewport.height - LOCATE_MARGIN * 2) / rect.height)));
      centerOn(browser, zoom);
    }
  // Re-run while an ancestor is being expanded or a stack member is being promoted.
  }, [locateRequest, viewport, browserById, zoneById, stackByBrowser, onSetZoneCollapsed, onSelectStackMember, onSelectionChange, onFocus]);

  useEffect(() => {
    if (fullscreenBrowserId && !snapshot.browsers.some((browser) => browser.id === fullscreenBrowserId)) onFullscreenChange(null);
  }, [fullscreenBrowserId, snapshot.browsers, onFullscreenChange]);

  const focusSemanticCard = (browser: BrowserSnapshot) => {
    centerOn(browser, SEMANTIC_FOCUS_ZOOM);
    onSelectionChange(new Set([browser.id]));
    void onFocus(browser.id);
  };

  const selectFromMinimap = async (browserId: string) => {
    const browser = browserById.get(browserId);
    if (!browser) return;
    const zone = zoneById.get(browser.zoneId ?? '');
    if (zone?.collapsed) await onSetZoneCollapsed(zone, false);
    const stack = stackByBrowser.get(browser.id);
    if (stack && stack.browserIds.at(-1) !== browser.id) await onSelectStackMember(stack.id, browser.id);
    onSelectionChange(new Set([browser.id]));
    await onFocus(browser.id);
    if (!browser.pin.viewport && viewport) {
      const rect = visualRect(browser);
      const zoom = Math.min(1, Math.max(INTERACTIVE_ZOOM_THRESHOLD,
        Math.min((viewport.width - LOCATE_MARGIN * 2) / rect.width, (viewport.height - LOCATE_MARGIN * 2) / rect.height)));
      centerOn(browser, zoom);
    }
  };

  const toggleViewportPin = (browser: BrowserSnapshot) => {
    if (browser.pin.viewport) { void onSetViewportPin(browser.id, null); return; }
    if (!viewport) return;
    const chrome = projectCardChrome(browser.worldRect, snapshot.camera, { x: viewport.x, y: viewport.y });
    const width = Math.min(0.9, Math.max(0.18, chrome.width / viewport.width));
    const height = Math.min(0.9, Math.max(0.18, chrome.height / viewport.height));
    const x = Math.max(0, Math.min(1 - width, (chrome.x - viewport.x) / viewport.width));
    const y = Math.max(0, Math.min(1 - height, (chrome.y - viewport.y) / viewport.height));
    void onSetViewportPin(browser.id, { x, y, width, height });
  };

  const setFullscreen = (browser: BrowserSnapshot) => {
    setMenuBrowserId(null);
    onSelectionChange(new Set([browser.id]));
    void onFocus(browser.id);
    onFullscreenChange(fullscreenBrowserId === browser.id ? null : browser.id);
  };

  const latestCardActions = useRef<BrowserCardActions | null>(null);
  useLayoutEffect(() => {
    latestCardActions.current = {
      select: selectCard,
      beginMove,
      beginResize,
      close: (browser) => { if (fullscreenBrowserId === browser.id) onFullscreenChange(null); void onClose(browser.id); },
      sleep: (browser) => { if (fullscreenBrowserId === browser.id) onFullscreenChange(null); void onSleep(browser.id); },
      wake: (browser) => void onWake(browser.id),
      reload: (browser) => void onReload(browser.id),
      stop: (browser) => void onStop(browser.id),
      back: (browser) => void onBack(browser.id),
      forward: (browser) => void onForward(browser.id),
      navigate: (browser, url) => void onNavigate(browser.id, url),
      assignProfile: (browser, profileId) => void onAssignProfile(browser.id, profileId),
      toggleMinimized: (browser) => void onSetPresentation([browser.id], browser.presentation === 'minimized' ? 'normal' : 'minimized'),
      toggleLocked: (browser) => void onSetLocked([browser.id], !browser.positionLocked),
      toggleSidebarPin: (browser) => void onSetSidebarPinned([browser.id], !browser.pin.sidebar),
      toggleViewportPin,
      duplicate: (browser) => void onDuplicate([browser.id]),
      fullscreen: setFullscreen,
      menuOpenChange: (browser, open) => setMenuBrowserId(open ? browser.id : null),
      selectStackMember: (stack, browserId) => void onSelectStackMember(stack.id, browserId),
      unstack: (stack) => void onUnstack(stack.id)
    };
  });
  // One identity for the lifetime of the canvas; every call runs the logic of the latest commit.
  const cardActions = useMemo<BrowserCardActions>(() => {
    const latest = () => latestCardActions.current!;
    return {
      select: (browser, event) => latest().select(browser, event),
      beginMove: (browser, event) => latest().beginMove(browser, event),
      beginResize: (browser, direction, event) => latest().beginResize(browser, direction, event),
      close: (browser) => latest().close(browser),
      sleep: (browser) => latest().sleep(browser),
      wake: (browser) => latest().wake(browser),
      reload: (browser) => latest().reload(browser),
      stop: (browser) => latest().stop(browser),
      back: (browser) => latest().back(browser),
      forward: (browser) => latest().forward(browser),
      navigate: (browser, url) => latest().navigate(browser, url),
      assignProfile: (browser, profileId) => latest().assignProfile(browser, profileId),
      toggleMinimized: (browser) => latest().toggleMinimized(browser),
      toggleLocked: (browser) => latest().toggleLocked(browser),
      toggleSidebarPin: (browser) => latest().toggleSidebarPin(browser),
      toggleViewportPin: (browser) => latest().toggleViewportPin(browser),
      duplicate: (browser) => latest().duplicate(browser),
      fullscreen: (browser) => latest().fullscreen(browser),
      menuOpenChange: (browser, open) => latest().menuOpenChange(browser, open),
      selectStackMember: (stack, browserId) => latest().selectStackMember(stack, browserId),
      unstack: (stack) => latest().unstack(stack)
    };
  }, []);

  const stackMembers = useMemo(() => new Map(snapshot.stacks.map((stack) => [
    stack.id,
    stack.browserIds.map((id) => browserById.get(id)).filter((candidate): candidate is BrowserSnapshot => Boolean(candidate))
  ] as const)), [snapshot.stacks, browserById]);

  const cardFor = (browser: BrowserSnapshot, rect: WorldRect, surface: 'world' | 'pinned' | 'immersive') => {
    const stack = stackByBrowser.get(browser.id);
    return (
      <BrowserCard
        actions={cardActions}
        browser={browser}
        key={`${surface}-${browser.id}`}
        multiSelected={selectedBrowserIds.size > 1 && selectedBrowserIds.has(browser.id)}
        profiles={snapshot.profiles}
        rect={rect}
        selected={snapshot.selectedBrowserId === browser.id}
        stack={stack}
        stackBrowsers={(stack && stackMembers.get(stack.id)) ?? NO_BROWSERS}
        surface={surface}
      />
    );
  };

  const worldVisible = (browser: BrowserSnapshot) => {
    const zone = browser.zoneId ? zoneById.get(browser.zoneId) : undefined;
    const stack = stackByBrowser.get(browser.id);
    return !browser.pin.viewport && !zone?.collapsed && (!stack || topStackBrowserIds.has(browser.id));
  };
  const pinnedBrowsers = snapshot.browsers.filter((browser) => browser.pin.viewport && !zoneById.get(browser.zoneId ?? '')?.collapsed);
  const immersiveBrowser = fullscreenBrowserId ? browserById.get(fullscreenBrowserId) : undefined;
  const marqueeRect = marquee ? {
    x: Math.min(marquee.start.x, marquee.current.x),
    y: Math.min(marquee.start.y, marquee.current.y),
    width: Math.abs(marquee.current.x - marquee.start.x),
    height: Math.abs(marquee.current.y - marquee.start.y)
  } : null;

  const zoneBounds = useMemo(() => new Map(snapshot.zones.map((zone) => [
    zone.id,
    boundsForWorldRects((browsersByZone.get(zone.id) ?? []).map(visualRect), ZONE_PADDING)
  ] as const)), [snapshot.zones, browsersByZone]);

  return (
    <main
      aria-label="Canvas de navegadores. Flechas para desplazar, más y menos para acercar o alejar."
      className={`canvas-viewport ${fullscreenBrowserId ? 'is-immersive' : ''}`}
      onKeyDown={handleKeyDown}
      onPointerDown={(event) => beginPan(event)}
      ref={viewportRef}
      tabIndex={0}
    >
      {!fullscreenBrowserId ? <div className="canvas-grid" style={{ backgroundPosition: `${snapshot.camera.panX}px ${snapshot.camera.panY}px`, backgroundSize: `${24 * snapshot.camera.zoom}px ${24 * snapshot.camera.zoom}px` }} /> : null}
      {!fullscreenBrowserId && !lowZoom ? (
        <div className="canvas-world" style={{ transform: `translate(${snapshot.camera.panX}px, ${snapshot.camera.panY}px) scale(${snapshot.camera.zoom})` }}>
          {snapshot.zones.map((zone) => {
            const bounds = zoneBounds.get(zone.id);
            if (!bounds) return null;
            if (zone.collapsed) return (
              <button className="collapsed-zone-chip native-occluder" key={zone.id} onClick={() => void onSetZoneCollapsed(zone, false)} onPointerDown={(event) => event.stopPropagation()} style={{ left: bounds.x, top: bounds.y, borderColor: zone.color }} type="button">
                <span style={{ background: zone.color }} />{zone.name}<small>{browsersByZone.get(zone.id)?.length ?? 0}</small>
              </button>
            );
            return (
              <section className="zone-frame" key={zone.id} style={{ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height, '--zone-color': zone.color } as React.CSSProperties}>
                <button className="zone-label native-occluder" onClick={() => void onSetZoneCollapsed(zone, true)} onPointerDown={(event) => event.stopPropagation()} type="button">
                  <span />{zone.name}<small>{browsersByZone.get(zone.id)?.length ?? 0}</small>
                </button>
              </section>
            );
          })}
          {snapshot.browsers.filter(worldVisible).map((browser) => cardFor(browser, visualRect(browser), 'world'))}
          {selectionCanTransform && selectedTransformBrowsers.length > 1 && selectionBounds ? (
            <div className="group-selection-box" style={{ left: selectionBounds.x, top: selectionBounds.y, width: selectionBounds.width, height: selectionBounds.height }}>
              {(['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as ResizeDirection[]).map((direction) => <span className={`resize-handle resize-${direction}`} key={direction} onPointerDown={(event) => beginGroupResize(direction, event)} />)}
            </div>
          ) : null}
          {marqueeRect ? <div className="selection-marquee" style={{ left: marqueeRect.x, top: marqueeRect.y, width: marqueeRect.width, height: marqueeRect.height }} /> : null}
          {snapGuides.map((guide) => <span className={`snap-guide is-${guide.axis}`} key={`${guide.axis}-${guide.worldPosition}`} style={guide.axis === 'x' ? { left: guide.worldPosition } : { top: guide.worldPosition }} />)}
        </div>
      ) : !fullscreenBrowserId ? (
        <div className="semantic-layer">
          {snapshot.browsers.filter((browser) => worldVisible(browser) && browser.presentation === 'normal').map((browser) => {
            const profileEntry = profileById.get(browser.profileId);
            if (!profileEntry) return null;
            const { profile, index } = profileEntry;
            return (
              <button className={`semantic-card ${snapshot.selectedBrowserId === browser.id ? 'is-selected' : ''}`} key={browser.id} onClick={() => focusSemanticCard(browser)} style={{ left: snapshot.camera.panX + browser.worldRect.x * snapshot.camera.zoom, top: snapshot.camera.panY + browser.worldRect.y * snapshot.camera.zoom, zIndex: browser.zIndex, '--profile-color': profileColor(profile, index) } as React.CSSProperties} type="button">
                <span className="semantic-icon">{browser.suspended ? <Moon size={18} /> : <span />}</span>
                <strong>{browser.title}</strong>
                <small>{displayDomain(browser.url)} · {profile.name}</small>
              </button>
            );
          })}
        </div>
      ) : null}

      {!fullscreenBrowserId && viewport ? (
        <div className="pinned-layer">
          {pinnedBrowsers.map((browser) => {
            const pin = browser.pin.viewport!;
            return cardFor(browser, { x: pin.x * viewport.width, y: pin.y * viewport.height, width: pin.width * viewport.width, height: pin.height * viewport.height }, 'pinned');
          })}
        </div>
      ) : null}

      {fullscreenBrowserId && immersiveBrowser && viewport ? (
        <div className="immersive-layer">{cardFor(immersiveBrowser, { x: 0, y: 0, width: viewport.width, height: viewport.height }, 'immersive')}</div>
      ) : null}

      {!fullscreenBrowserId && selectedBrowserIds.size > 1 ? (
        <div className="selection-toolbar native-occluder">
          <strong>{selectedBrowserIds.size} seleccionados</strong>
          <button onClick={() => void onSetLocked(selectedIds, !selectedBrowsers.every((browser) => browser.positionLocked))} type="button">{selectedBrowsers.every((browser) => browser.positionLocked) ? <Unlock size={13} /> : <Lock size={13} />} Posición</button>
          <button onClick={() => void onSetPresentation(selectedIds, 'minimized')} type="button"><Minimize2 size={13} /> Minimizar</button>
          <button onClick={() => void onSetSidebarPinned(selectedIds, true)} type="button"><Pin size={13} /> Fijar</button>
          <button onClick={() => void onDuplicate(selectedIds)} type="button"><Copy size={13} /> Duplicar</button>
          <button disabled={new Set(selectedBrowsers.map((browser) => browser.profileId)).size !== 1} onClick={() => void onCreateZone(selectedIds)} type="button">Zona</button>
          <button disabled={new Set(selectedBrowsers.map((browser) => browser.zoneId)).size !== 1 || !selectedBrowsers[0]?.zoneId} onClick={() => void onCreateStack(selectedBrowsers[0]!.zoneId!, selectedIds)} type="button"><Layers3 size={13} /> Stack</button>
          <button className="danger-action" onClick={() => { void (async () => { for (const id of selectedIds) await onClose(id); })(); }} type="button"><X size={13} /> Cerrar</button>
        </div>
      ) : null}

      {!fullscreenBrowserId ? (
        <>
          <Minimap browsers={snapshot.browsers} camera={snapshot.camera} hidden={layout?.minimapCovered ?? false} onSelect={(browserId) => void selectFromMinimap(browserId)} selectedBrowserId={snapshot.selectedBrowserId} viewportSize={viewport ?? { width: 1, height: 1 }} />
          <div className="canvas-navigator native-occluder" aria-label="Navegación del canvas">
            <button aria-label="Mover a la izquierda" onClick={() => onUpdateCamera((camera) => ({ ...camera, panX: camera.panX + KEYBOARD_PAN_LARGE_STEP }))} type="button"><ArrowLeft size={13} /></button>
            <button aria-label="Mover arriba" onClick={() => onUpdateCamera((camera) => ({ ...camera, panY: camera.panY + KEYBOARD_PAN_LARGE_STEP }))} type="button"><ArrowUp size={13} /></button>
            <button aria-label="Mover abajo" onClick={() => onUpdateCamera((camera) => ({ ...camera, panY: camera.panY - KEYBOARD_PAN_LARGE_STEP }))} type="button"><ArrowDown size={13} /></button>
            <button aria-label="Mover a la derecha" onClick={() => onUpdateCamera((camera) => ({ ...camera, panX: camera.panX - KEYBOARD_PAN_LARGE_STEP }))} type="button"><ArrowRight size={13} /></button>
          </div>
          <div className="canvas-position">x {Math.round(-snapshot.camera.panX / snapshot.camera.zoom)} · y {Math.round(-snapshot.camera.panY / snapshot.camera.zoom)}</div>
        </>
      ) : null}
    </main>
  );
}
