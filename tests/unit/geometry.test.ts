import { describe, expect, it } from 'vitest';
import { projectWorldRect, screenDeltaToWorld, shouldShowNativeView, zoomAroundPoint } from '../../src/shared/geometry';

describe('canvas geometry', () => {
  it('projects a world card interior into integer native-view bounds', () => {
    expect(projectWorldRect(
      { x: 100, y: 50, width: 400, height: 300 },
      { panX: 20, panY: -10, zoom: 0.5 },
      { x: 218, y: 60 }
    )).toEqual({ x: 288, y: 94, width: 200, height: 131 });
  });

  it('converts pointer deltas back into world coordinates', () => {
    expect(screenDeltaToWorld({ x: 40, y: -20 }, 0.5)).toEqual({ x: 80, y: -40 });
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
    const viewport = { x: 218, y: 60, width: 1000, height: 700 };
    const inside = { x: 300, y: 100, width: 500, height: 400 };
    expect(shouldShowNativeView(0.8, inside, viewport, false)).toBe(true);
    expect(shouldShowNativeView(0.49, inside, viewport, false)).toBe(false);
    expect(shouldShowNativeView(0.8, inside, viewport, true)).toBe(false);
    expect(shouldShowNativeView(0.8, { ...inside, x: 100 }, viewport, false)).toBe(false);
  });
});
