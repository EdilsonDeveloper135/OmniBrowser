import {
  CARD_BORDER_WIDTH,
  CARD_CHROME_OVERFLOW,
  CARD_CONTENT_INSET,
  INTERACTIVE_ZOOM_THRESHOLD,
  MAX_CAMERA_PAN,
  MAX_SCREEN_COORDINATE,
  MAX_SCREEN_SIZE,
  MAX_WORLD_COORDINATE,
  MAX_WORLD_SIZE,
  MAX_ZOOM,
  MIN_BROWSER_HEIGHT,
  MIN_BROWSER_WIDTH,
  MIN_ZOOM,
  MINIMAP_MARGIN,
  MINIMAP_SIZE,
  SNAP_THRESHOLD_PX
} from './constants';
import type { Camera, LayoutItem, ScreenRect, WorldRect } from './schemas';

// Coordinate spaces: world (card geometry), canvas (relative to the canvas viewport) and screen (window content DIPs).
// screen = canvasOrigin + pan + world × zoom

export interface Point {
  x: number;
  y: number;
}

export interface CanvasCard {
  id: string;
  worldRect: WorldRect;
  zIndex: number;
  suspended: boolean;
  crashed: boolean;
  nativeHidden?: boolean;
  chromeHidden?: boolean;
  surfaceLayer?: LayoutItem['surfaceLayer'];
  screenContentBounds?: ScreenRect;
  screenChromeBounds?: ScreenRect;
}

export interface CanvasLayout {
  items: LayoutItem[];
  minimapCovered: boolean;
}

export interface SnapGuide {
  axis: 'x' | 'y';
  worldPosition: number;
}

export interface SoftSnapResult {
  rect: WorldRect;
  guides: SnapGuide[];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : 0));
}

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number.isFinite(zoom) ? zoom : 1));
}

/** Zoom values from repeated button steps are rounded to whole percentages to avoid floating-point drift. */
export function roundZoom(zoom: number): number {
  return clampZoom(Math.round(zoom * 100) / 100);
}

export function clampCamera(camera: Camera): Camera {
  return {
    panX: clamp(camera.panX, -MAX_CAMERA_PAN, MAX_CAMERA_PAN),
    panY: clamp(camera.panY, -MAX_CAMERA_PAN, MAX_CAMERA_PAN),
    zoom: clampZoom(camera.zoom)
  };
}

/** Keeps a card inside the persisted schema bounds and above the minimum card size. NaN collapses to a safe value. */
export function clampWorldRect(rect: WorldRect): WorldRect {
  return {
    x: clamp(rect.x, -MAX_WORLD_COORDINATE, MAX_WORLD_COORDINATE),
    y: clamp(rect.y, -MAX_WORLD_COORDINATE, MAX_WORLD_COORDINATE),
    width: clamp(Number.isFinite(rect.width) ? rect.width : MIN_BROWSER_WIDTH, MIN_BROWSER_WIDTH, MAX_WORLD_SIZE),
    height: clamp(Number.isFinite(rect.height) ? rect.height : MIN_BROWSER_HEIGHT, MIN_BROWSER_HEIGHT, MAX_WORLD_SIZE)
  };
}

/** Rounds edges rather than position and size independently, so adjacent rectangles never drift apart by a pixel. */
export function snapRect(left: number, top: number, right: number, bottom: number): ScreenRect {
  const x = Math.round(left);
  const y = Math.round(top);
  return { x, y, width: Math.max(1, Math.round(right) - x), height: Math.max(1, Math.round(bottom) - y) };
}

/** Bounds of the Chromium surface of a card: inside the 1px border, below the header and inside the resize gutters. */
export function projectWorldRect(rect: WorldRect, camera: Camera, viewportOrigin: Point): ScreenRect {
  const zoom = clampZoom(camera.zoom);
  const originX = viewportOrigin.x + camera.panX;
  const originY = viewportOrigin.y + camera.panY;
  return snapRect(
    originX + (rect.x + CARD_BORDER_WIDTH + CARD_CONTENT_INSET.left) * zoom,
    originY + (rect.y + CARD_BORDER_WIDTH + CARD_CONTENT_INSET.top) * zoom,
    originX + (rect.x + rect.width - CARD_BORDER_WIDTH - CARD_CONTENT_INSET.right) * zoom,
    originY + (rect.y + rect.height - CARD_BORDER_WIDTH - CARD_CONTENT_INSET.bottom) * zoom
  );
}

/** Everything React draws for a card, including resize handles and the selection ring that extend past its border. */
export function projectCardChrome(rect: WorldRect, camera: Camera, viewportOrigin: Point): ScreenRect {
  const zoom = clampZoom(camera.zoom);
  const originX = viewportOrigin.x + camera.panX;
  const originY = viewportOrigin.y + camera.panY;
  return {
    x: originX + (rect.x - CARD_CHROME_OVERFLOW) * zoom,
    y: originY + (rect.y - CARD_CHROME_OVERFLOW) * zoom,
    width: (rect.width + CARD_CHROME_OVERFLOW * 2) * zoom,
    height: (rect.height + CARD_CHROME_OVERFLOW * 2) * zoom
  };
}

export function screenToWorld(point: Point, camera: Camera, viewportOrigin: Point): Point {
  const zoom = clampZoom(camera.zoom);
  return { x: (point.x - viewportOrigin.x - camera.panX) / zoom, y: (point.y - viewportOrigin.y - camera.panY) / zoom };
}

/** A rectangle in world units that is not a card (an overlay drawn inside the canvas world), so no size limits apply. */
export interface WorldArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Converts a measured screen rectangle of something drawn inside the canvas world into world units. */
export function screenAreaToWorld(area: { left: number; top: number; right: number; bottom: number }, camera: Camera, viewportOrigin: Point): WorldArea {
  const zoom = clampZoom(camera.zoom);
  const topLeft = screenToWorld({ x: area.left, y: area.top }, camera, viewportOrigin);
  return { x: topLeft.x, y: topLeft.y, width: (area.right - area.left) / zoom, height: (area.bottom - area.top) / zoom };
}

/** Screen bounds of a world area under the given camera, rounded by edge like card surfaces. */
export function projectWorldArea(area: WorldArea, camera: Camera, viewportOrigin: Point): ScreenRect {
  const zoom = clampZoom(camera.zoom);
  const originX = viewportOrigin.x + camera.panX;
  const originY = viewportOrigin.y + camera.panY;
  return snapRect(originX + area.x * zoom, originY + area.y * zoom, originX + (area.x + area.width) * zoom, originY + (area.y + area.height) * zoom);
}

export function screenDeltaToWorld(delta: Point, zoom: number): Point {
  const safeZoom = clampZoom(zoom);
  return { x: delta.x / safeZoom, y: delta.y / safeZoom };
}

export function screenRectsIntersect(a: ScreenRect, b: ScreenRect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

export function screenRectFullyInside(rect: ScreenRect, viewport: ScreenRect): boolean {
  return rect.x >= viewport.x && rect.y >= viewport.y && rect.x + rect.width <= viewport.x + viewport.width && rect.y + rect.height <= viewport.y + viewport.height;
}

export function boundsForWorldRects(rects: readonly WorldRect[], padding = 0): WorldRect | null {
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left - padding, y: top - padding, width: right - left + padding * 2, height: bottom - top + padding * 2 };
}

function nearestOffset(anchors: readonly number[], targets: readonly number[], threshold: number): { offset: number; target: number } | null {
  let best: { offset: number; target: number } | null = null;
  for (const anchor of anchors) {
    for (const target of targets) {
      const offset = target - anchor;
      if (Math.abs(offset) > threshold || (best && Math.abs(best.offset) <= Math.abs(offset))) continue;
      best = { offset, target };
    }
  }
  return best;
}

/** Soft alignment for a moving card. The threshold is expressed in screen pixels and converted to world units. */
export function snapMovedWorldRect(rect: WorldRect, targets: readonly WorldRect[], zoom: number, thresholdPx = SNAP_THRESHOLD_PX): SoftSnapResult {
  const threshold = thresholdPx / clampZoom(zoom);
  const targetXs = targets.flatMap((target) => [target.x, target.x + target.width / 2, target.x + target.width]);
  const targetYs = targets.flatMap((target) => [target.y, target.y + target.height / 2, target.y + target.height]);
  const x = nearestOffset([rect.x, rect.x + rect.width / 2, rect.x + rect.width], targetXs, threshold);
  const y = nearestOffset([rect.y, rect.y + rect.height / 2, rect.y + rect.height], targetYs, threshold);
  return {
    rect: { ...rect, x: rect.x + (x?.offset ?? 0), y: rect.y + (y?.offset ?? 0) },
    guides: [
      ...(x ? [{ axis: 'x' as const, worldPosition: x.target }] : []),
      ...(y ? [{ axis: 'y' as const, worldPosition: y.target }] : [])
    ]
  };
}

/** Soft alignment for the edges controlled by an active resize handle. */
export function snapResizedWorldRect(rect: WorldRect, direction: string, targets: readonly WorldRect[], zoom: number, thresholdPx = SNAP_THRESHOLD_PX): SoftSnapResult {
  const threshold = thresholdPx / clampZoom(zoom);
  const targetXs = targets.flatMap((target) => [target.x, target.x + target.width / 2, target.x + target.width]);
  const targetYs = targets.flatMap((target) => [target.y, target.y + target.height / 2, target.y + target.height]);
  const horizontalEdge = direction.includes('w') ? rect.x : direction.includes('e') ? rect.x + rect.width : null;
  const verticalEdge = direction.includes('n') ? rect.y : direction.includes('s') ? rect.y + rect.height : null;
  const x = horizontalEdge === null ? null : nearestOffset([horizontalEdge], targetXs, threshold);
  const y = verticalEdge === null ? null : nearestOffset([verticalEdge], targetYs, threshold);
  let next = { ...rect };
  if (x) {
    if (direction.includes('w')) {
      next.x += x.offset;
      next.width -= x.offset;
    } else next.width += x.offset;
  }
  if (y) {
    if (direction.includes('n')) {
      next.y += y.offset;
      next.height -= y.offset;
    } else next.height += y.offset;
  }
  next = clampWorldRect(next);
  return {
    rect: next,
    guides: [
      ...(x ? [{ axis: 'x' as const, worldPosition: x.target }] : []),
      ...(y ? [{ axis: 'y' as const, worldPosition: y.target }] : [])
    ]
  };
}

export function shouldShowNativeView(zoom: number, contentRect: ScreenRect, viewport: ScreenRect, suspended: boolean): boolean {
  return !suspended && zoom >= INTERACTIVE_ZOOM_THRESHOLD && screenRectFullyInside(contentRect, viewport);
}

export function zoomAroundPoint(camera: Camera, nextZoomValue: number, pointerInViewport: Point): Camera {
  const nextZoom = clampZoom(nextZoomValue);
  const worldX = (pointerInViewport.x - camera.panX) / camera.zoom;
  const worldY = (pointerInViewport.y - camera.panY) / camera.zoom;
  return {
    panX: pointerInViewport.x - worldX * nextZoom,
    panY: pointerInViewport.y - worldY * nextZoom,
    zoom: nextZoom
  };
}

export function minimapRect(viewport: ScreenRect): ScreenRect {
  return {
    x: viewport.x + viewport.width - MINIMAP_MARGIN - MINIMAP_SIZE.width,
    y: viewport.y + viewport.height - MINIMAP_MARGIN - MINIMAP_SIZE.height,
    width: MINIMAP_SIZE.width,
    height: MINIMAP_SIZE.height
  };
}

function clampToScreenSchema(rect: ScreenRect): ScreenRect {
  return {
    x: clamp(rect.x, -MAX_SCREEN_COORDINATE, MAX_SCREEN_COORDINATE),
    y: clamp(rect.y, -MAX_SCREEN_COORDINATE, MAX_SCREEN_COORDINATE),
    width: clamp(rect.width, 1, MAX_SCREEN_SIZE),
    height: clamp(rect.height, 1, MAX_SCREEN_SIZE)
  };
}

/**
 * Native views are composited above the whole shell, so a Chromium surface may only be shown where nothing React draws
 * would be covered by it: fully inside the canvas, not under any higher card (header, border or handles) and not under a
 * transient overlay such as a notice. The minimap yields instead: it is hidden while a visible surface covers it.
 */
export function computeCanvasLayout(cards: readonly CanvasCard[], camera: Camera, viewport: ScreenRect, occluders: readonly ScreenRect[] = []): CanvasLayout {
  const origin = { x: viewport.x, y: viewport.y };
  const layerRank = (layer: LayoutItem['surfaceLayer'] | undefined) => layer === 'immersive' ? 2 : layer === 'pinned' ? 1 : 0;
  const chrome = cards.filter((card) => !card.chromeHidden).map((card) => ({
    id: card.id,
    layer: layerRank(card.surfaceLayer),
    zIndex: card.zIndex,
    rect: card.screenChromeBounds ?? projectCardChrome(card.worldRect, camera, origin)
  }));
  const minimap = minimapRect(viewport);
  let minimapCovered = false;
  const items = cards.map((card) => {
    const bounds = card.screenContentBounds ?? projectWorldRect(card.worldRect, camera, origin);
    const directSurface = card.screenContentBounds !== undefined;
    const ownLayer = layerRank(card.surfaceLayer);
    const visible = !card.nativeHidden
      && !card.suspended
      && (directSurface ? screenRectFullyInside(bounds, viewport) : shouldShowNativeView(camera.zoom, bounds, viewport, false))
      && !card.crashed
      && !chrome.some((other) => other.id !== card.id && (other.layer > ownLayer || (other.layer === ownLayer && other.zIndex > card.zIndex)) && screenRectsIntersect(bounds, other.rect))
      && !occluders.some((occluder) => screenRectsIntersect(bounds, occluder));
    if (visible && screenRectsIntersect(bounds, minimap)) minimapCovered = true;
    return {
      browserId: card.id,
      worldRect: clampWorldRect(card.worldRect),
      screenBounds: clampToScreenSchema(bounds),
      visible,
      surfaceLayer: card.surfaceLayer ?? 'normal'
    };
  });
  return { items, minimapCovered };
}
