import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CARD_BORDER_WIDTH,
  CARD_CHROME_OVERFLOW,
  CARD_CONTENT_INSET,
  MAX_SCREEN_COORDINATE,
  MINIMAP_MARGIN,
  MINIMAP_SIZE,
  PROFILE_RAIL_WIDTH,
  ZOOM_STEP
} from '../../src/shared/constants';
import {
  clampCamera,
  clampWorldRect,
  boundsForWorldRects,
  computeCanvasLayout,
  projectWorldRect,
  roundZoom,
  screenDeltaToWorld,
  screenToWorld,
  snapMovedWorldRect,
  snapResizedWorldRect,
  shouldShowNativeView,
  zoomAroundPoint,
  type CanvasCard
} from '../../src/shared/geometry';

const viewport = { x: PROFILE_RAIL_WIDTH, y: 60, width: 1440 - PROFILE_RAIL_WIDTH, height: 812 };

function card(id: string, zIndex: number, worldRect: CanvasCard['worldRect'], overrides: Partial<CanvasCard> = {}): CanvasCard {
  return { id, zIndex, worldRect, suspended: false, crashed: false, ...overrides };
}

describe('canvas geometry', () => {
  it('projects a world card interior into integer native-view bounds', () => {
    // Content slot: inside the 1px border, 38px below the top edge and 16px from the other edges, all scaled by zoom.
    // left 238 + 117×0.5 = 296.5, top 50 + 89×0.5 = 94.5, right 238 + 483×0.5 = 479.5, bottom 50 + 333×0.5 = 216.5.
    expect(projectWorldRect(
      { x: 100, y: 50, width: 400, height: 300 },
      { panX: 20, panY: -10, zoom: 0.5 },
      { x: PROFILE_RAIL_WIDTH, y: 60 }
    )).toEqual({ x: 359, y: 95, width: 183, height: 122 });
  });

  it('matches the native bounds measured from the rendered DOM of the default card', () => {
    // Measured in the production shell at 1440×900: [data-browser-content] and the WebContentsView were (291,151,497×315).
    expect(projectWorldRect({ x: 72, y: 72, width: 640, height: 440 }, { panX: 0, panY: 0, zoom: 0.82 }, { x: PROFILE_RAIL_WIDTH, y: 60 }))
      .toEqual({ x: 353, y: 151, width: 497, height: 315 });
  });

  it('keeps geometry constants in sync with the stylesheet that draws the cards', () => {
    const css = readFileSync(path.join(process.cwd(), 'src', 'renderer', 'styles.css'), 'utf8');
    expect(css).toMatch(new RegExp(`\\.browser-card \\{[^}]*border: ${CARD_BORDER_WIDTH}px solid`));
    expect(css).toContain(`.browser-content-slot { position: absolute; inset: ${CARD_CONTENT_INSET.top}px ${CARD_CONTENT_INSET.right}px ${CARD_CONTENT_INSET.bottom}px;`);
    expect(CARD_CONTENT_INSET.left).toBe(CARD_CONTENT_INSET.right);
    expect(css).toContain(`.resize-ne { top: -${CARD_CHROME_OVERFLOW}px; right: -${CARD_CHROME_OVERFLOW}px;`);
    expect(css).toContain(`.minimap { position: absolute; right: ${MINIMAP_MARGIN}px; bottom: ${MINIMAP_MARGIN}px; width: ${MINIMAP_SIZE.width}px; height: ${MINIMAP_SIZE.height}px;`);
  });

  it('converts pointer deltas back into world coordinates', () => {
    expect(screenDeltaToWorld({ x: 40, y: -20 }, 0.5)).toEqual({ x: 80, y: -40 });
  });

  it('maps a screen point to the same world point used to project it', () => {
    const camera = { panX: -35, panY: 12, zoom: 1.3 };
    const origin = { x: PROFILE_RAIL_WIDTH, y: 60 };
    const world = { x: 412, y: -97 };
    const screen = { x: origin.x + camera.panX + world.x * camera.zoom, y: origin.y + camera.panY + world.y * camera.zoom };
    const back = screenToWorld(screen, camera, origin);
    expect(back.x).toBeCloseTo(world.x, 10);
    expect(back.y).toBeCloseTo(world.y, 10);
  });

  it('keeps the world point beneath the pointer fixed while zooming', () => {
    const before = { panX: 10, panY: 20, zoom: 1 };
    const pointer = { x: 210, y: 120 };
    const after = zoomAroundPoint(before, 2, pointer);
    const worldBefore = { x: (pointer.x - before.panX) / before.zoom, y: (pointer.y - before.panY) / before.zoom };
    const worldAfter = { x: (pointer.x - after.panX) / after.zoom, y: (pointer.y - after.panY) / after.zoom };
    expect(worldAfter).toEqual(worldBefore);
  });

  it('hides native views at semantic zoom, when suspended, or when partially outside the canvas', () => {
    const canvas = { x: PROFILE_RAIL_WIDTH, y: 60, width: 1000, height: 700 };
    const inside = { x: 300, y: 100, width: 500, height: 400 };
    expect(shouldShowNativeView(0.8, inside, canvas, false)).toBe(true);
    expect(shouldShowNativeView(0.49, inside, canvas, false)).toBe(false);
    expect(shouldShowNativeView(0.8, inside, canvas, true)).toBe(false);
    expect(shouldShowNativeView(0.8, { ...inside, x: 100 }, canvas, false)).toBe(false);
  });

  it('steps zoom buttons without floating-point drift and clamps to 25–200 %', () => {
    let zoom = 0.82;
    for (let step = 0; step < 4; step += 1) zoom = roundZoom(zoom - ZOOM_STEP);
    expect(zoom).toBe(0.42);
    expect(roundZoom(0.1)).toBe(0.25);
    expect(roundZoom(9)).toBe(2);
    expect(roundZoom(Number.NaN)).toBe(1);
  });

  it('clamps cameras and rectangles to the persisted schema and repairs NaN', () => {
    expect(clampCamera({ panX: Number.NaN, panY: 5e9, zoom: 0 })).toEqual({ panX: 0, panY: 1_000_000, zoom: 0.25 });
    expect(clampWorldRect({ x: -5e9, y: Number.NaN, width: 10, height: Number.POSITIVE_INFINITY })).toEqual({ x: -1_000_000, y: 0, width: 320, height: 240 });
  });

  it('derives padded group bounds and softly snaps edges and centers in screen-pixel distance', () => {
    expect(boundsForWorldRects([
      { x: 20, y: 30, width: 100, height: 80 },
      { x: 180, y: 10, width: 60, height: 200 }
    ], 10)).toEqual({ x: 10, y: 0, width: 240, height: 220 });

    const target = { x: 500, y: 100, width: 200, height: 200 };
    expect(snapMovedWorldRect({ x: 393, y: 96, width: 100, height: 100 }, [target], 1)).toEqual({
      rect: { x: 400, y: 100, width: 100, height: 100 },
      guides: [
        { axis: 'x', worldPosition: 500 },
        { axis: 'y', worldPosition: 100 }
      ]
    });
    expect(snapMovedWorldRect({ x: 393, y: 96, width: 100, height: 100 }, [target], 2).rect.x).toBe(393);
    expect(snapResizedWorldRect({ x: 0, y: 100, width: 493, height: 240 }, 'e', [target], 1)).toMatchObject({
      rect: { x: 0, y: 100, width: 500, height: 240 },
      guides: [{ axis: 'x', worldPosition: 500 }]
    });
  });
});

describe('native view layout', () => {
  const camera = { panX: 0, panY: 0, zoom: 1 };

  it('hides a card whose content is covered by the header or handles of a higher card', () => {
    const lower = card('lower', 1, { x: 40, y: 40, width: 640, height: 440 });
    const upper = card('upper', 2, { x: 90, y: 80, width: 640, height: 440 });
    const layout = computeCanvasLayout([lower, upper], camera, viewport);
    expect(layout.items.find((item) => item.browserId === 'lower')?.visible).toBe(false);
    expect(layout.items.find((item) => item.browserId === 'upper')?.visible).toBe(true);
  });

  it('keeps side-by-side cards visible when only their outer chrome gaps are adjacent', () => {
    const left = card('left', 2, { x: 20, y: 20, width: 320, height: 260 });
    const right = card('right', 1, { x: 360, y: 20, width: 320, height: 260 });
    expect(computeCanvasLayout([left, right], { panX: 0, panY: 0, zoom: 0.8 }, viewport).items.every((item) => item.visible)).toBe(true);
  });

  it('treats a visible notice as an occluder and reports when a surface covers the minimap', () => {
    const cornerCard = card('corner', 1, { x: 650, y: 400, width: 500, height: 400 });
    const plain = computeCanvasLayout([cornerCard], camera, viewport);
    expect(plain.items[0]?.visible).toBe(true);
    expect(plain.minimapCovered).toBe(true);
    const withNotice = computeCanvasLayout([cornerCard], camera, viewport, [{ x: 1000, y: 780, width: 420, height: 44 }]);
    expect(withNotice.items[0]?.visible).toBe(false);
    expect(withNotice.minimapCovered).toBe(false);
  });

  it('never shows suspended, crashed or semantic-zoom cards', () => {
    const rect = { x: 40, y: 40, width: 640, height: 440 };
    expect(computeCanvasLayout([card('s', 1, rect, { suspended: true })], camera, viewport).items[0]?.visible).toBe(false);
    expect(computeCanvasLayout([card('c', 1, rect, { crashed: true })], camera, viewport).items[0]?.visible).toBe(false);
    expect(computeCanvasLayout([card('z', 1, rect)], { ...camera, zoom: 0.49 }, viewport).items[0]?.visible).toBe(false);
  });

  it('keeps far off-screen bounds within the IPC schema so one card cannot invalidate the whole batch', () => {
    const layout = computeCanvasLayout([card('far', 1, { x: 900_000, y: -900_000, width: 640, height: 440 })], { panX: 0, panY: 0, zoom: 2 }, viewport);
    const bounds = layout.items[0]!.screenBounds;
    expect(layout.items[0]?.visible).toBe(false);
    expect(Math.abs(bounds.x)).toBeLessThanOrEqual(MAX_SCREEN_COORDINATE);
    expect(Math.abs(bounds.y)).toBeLessThanOrEqual(MAX_SCREEN_COORDINATE);
  });

  it('orders direct pinned and immersive surfaces above world cards regardless of z-index', () => {
    const normal = card('normal', 100, { x: 40, y: 40, width: 640, height: 440 });
    const pinned = card('pinned', 1, { x: 900, y: 900, width: 640, height: 440 }, {
      surfaceLayer: 'pinned',
      screenContentBounds: { x: 340, y: 120, width: 420, height: 300 },
      screenChromeBounds: { x: 320, y: 80, width: 460, height: 360 }
    });
    const withPin = computeCanvasLayout([normal, pinned], camera, viewport);
    expect(withPin.items.find((item) => item.browserId === 'normal')?.visible).toBe(false);
    expect(withPin.items.find((item) => item.browserId === 'pinned')).toMatchObject({
      visible: true,
      surfaceLayer: 'pinned',
      screenBounds: { x: 340, y: 120, width: 420, height: 300 }
    });

    const immersive = card('immersive', 0, { x: 0, y: 0, width: 640, height: 440 }, {
      surfaceLayer: 'immersive',
      screenContentBounds: { x: 300, y: 100, width: 900, height: 650 },
      screenChromeBounds: { x: 280, y: 60, width: 1160, height: 812 }
    });
    const full = computeCanvasLayout([pinned, immersive], camera, viewport);
    expect(full.items.find((item) => item.browserId === 'pinned')?.visible).toBe(false);
    expect(full.items.find((item) => item.browserId === 'immersive')?.visible).toBe(true);
  });

  it('hides minimized or collapsed native surfaces through the explicit nativeHidden flag', () => {
    const hidden = card('hidden', 1, { x: 40, y: 40, width: 640, height: 440 }, { nativeHidden: true });
    expect(computeCanvasLayout([hidden], camera, viewport).items[0]?.visible).toBe(false);
  });

  it('does not let chrome from a collapsed zone or hidden stack member occlude a visible surface', () => {
    const worldRect = { x: 40, y: 40, width: 500, height: 360 };
    const layout = computeCanvasLayout([
      card('visible', 1, worldRect),
      card('collapsed', 2, worldRect, { nativeHidden: true, chromeHidden: true })
    ], camera, viewport);
    expect(layout.items.find((item) => item.browserId === 'visible')?.visible).toBe(true);
    expect(layout.items.find((item) => item.browserId === 'collapsed')?.visible).toBe(false);
  });
});
