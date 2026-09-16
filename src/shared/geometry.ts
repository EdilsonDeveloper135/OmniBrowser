import {
  CARD_HEADER_HEIGHT,
  INTERACTIVE_ZOOM_THRESHOLD,
  MAX_ZOOM,
  MIN_BROWSER_HEIGHT,
  MIN_BROWSER_WIDTH,
  MIN_ZOOM
} from './constants';
import type { Camera, ScreenRect, WorldRect } from './schemas';

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function constrainWorldRect(rect: WorldRect): WorldRect {
  return {
    x: Number.isFinite(rect.x) ? rect.x : 0,
    y: Number.isFinite(rect.y) ? rect.y : 0,
    width: Math.max(MIN_BROWSER_WIDTH, Number.isFinite(rect.width) ? rect.width : MIN_BROWSER_WIDTH),
    height: Math.max(MIN_BROWSER_HEIGHT, Number.isFinite(rect.height) ? rect.height : MIN_BROWSER_HEIGHT)
  };
}

export function projectWorldRect(rect: WorldRect, camera: Camera, viewportOrigin: { x: number; y: number }): ScreenRect {
  const zoom = clampZoom(camera.zoom);
  return {
    x: Math.round(viewportOrigin.x + camera.panX + rect.x * zoom),
    y: Math.round(viewportOrigin.y + camera.panY + (rect.y + CARD_HEADER_HEIGHT) * zoom),
    width: Math.max(1, Math.round(rect.width * zoom)),
    height: Math.max(1, Math.round((rect.height - CARD_HEADER_HEIGHT) * zoom))
  };
}

export function screenDeltaToWorld(delta: { x: number; y: number }, zoom: number): { x: number; y: number } {
  const safeZoom = clampZoom(zoom);
  return { x: delta.x / safeZoom, y: delta.y / safeZoom };
}

export function screenRectsIntersect(a: ScreenRect, b: ScreenRect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

export function screenRectFullyInside(rect: ScreenRect, viewport: ScreenRect): boolean {
  return rect.x >= viewport.x && rect.y >= viewport.y && rect.x + rect.width <= viewport.x + viewport.width && rect.y + rect.height <= viewport.y + viewport.height;
}

export function shouldShowNativeView(zoom: number, contentRect: ScreenRect, viewport: ScreenRect, suspended: boolean): boolean {
  return !suspended && zoom >= INTERACTIVE_ZOOM_THRESHOLD && screenRectFullyInside(contentRect, viewport);
}

export function zoomAroundPoint(camera: Camera, nextZoomValue: number, pointerInViewport: { x: number; y: number }): Camera {
  const nextZoom = clampZoom(nextZoomValue);
  const worldX = (pointerInViewport.x - camera.panX) / camera.zoom;
  const worldY = (pointerInViewport.y - camera.panY) / camera.zoom;
  return {
    panX: pointerInViewport.x - worldX * nextZoom,
    panY: pointerInViewport.y - worldY * nextZoom,
    zoom: nextZoom
  };
}
