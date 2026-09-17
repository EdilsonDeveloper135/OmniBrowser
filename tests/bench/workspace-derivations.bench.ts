import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, it } from 'vitest';
import { WorkspaceModel } from '../../src/main/domain/workspace-model';
import { serializeWorkspace } from '../../src/main/persistence/workspace-store';
import { computeCanvasLayout, snapMovedWorldRect, type CanvasCard } from '../../src/shared/geometry';
import { layoutBatchSchema, type BrowserSnapshot, type WorkspaceFile, type WorkspaceSnapshot } from '../../src/shared/schemas';
import { browserMatchesSidebarSearch, buildSidebarTreeIndex, normalizeSidebarSearch } from '../../src/renderer/lib/sidebar-tree';
import { mergeBrowserState } from '../../src/renderer/lib/snapshot-merge';

// Machine-specific timings for before/after comparisons of the derivations that run per keystroke, per frame or per
// runtime event with the maximum workspace (500 browsers). `npm run bench` writes test-results/bench/<label>.json
// (OMNIBROWSER_BENCH_LABEL); the numbers are observations of one machine, not CI gates.

interface Timing { iterations: number; meanMs: number; p50Ms: number; p95Ms: number }
const timings: Record<string, Timing> = {};

function measure(name: string, fn: () => unknown, budgetMs = 400): void {
  for (let warmup = 0; warmup < 20; warmup += 1) fn();
  const samples: number[] = [];
  const started = performance.now();
  while (performance.now() - started < budgetMs || samples.length < 30) {
    const before = performance.now();
    fn();
    samples.push(performance.now() - before);
  }
  samples.sort((a, b) => a - b);
  const round = (value: number) => Number(value.toFixed(4));
  timings[name] = {
    iterations: samples.length,
    meanMs: round(samples.reduce((total, sample) => total + sample, 0) / samples.length),
    p50Ms: round(samples[Math.floor(samples.length * 0.5)]!),
    p95Ms: round(samples[Math.floor(samples.length * 0.95)]!)
  };
}

afterAll(() => {
  const label = process.env.OMNIBROWSER_BENCH_LABEL ?? 'run';
  const directory = path.join(process.cwd(), 'test-results', 'bench');
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, `${label}-${process.arch}.json`), `${JSON.stringify({ label, node: process.version, timings }, null, 2)}\n`);
  console.table(timings);
});

const BROWSERS = 500;
const timestamp = '2026-09-16T00:00:00.000Z';

function workspaceFile(): WorkspaceFile {
  const profileId = randomUUID();
  const zones = Array.from({ length: 20 }, (_, index) => ({ id: randomUUID(), profileId, name: `Zona ${index}`, color: '#2f81f7', collapsed: false, createdAt: timestamp, updatedAt: timestamp }));
  const browsers = Array.from({ length: BROWSERS }, (_, index) => {
    const url = `https://site-${index % 37}.example.com/articles/${index}?ref=bench`;
    return {
      id: randomUUID(),
      profileId,
      zoneId: index < 400 ? zones[index % zones.length]!.id : null,
      worldRect: { x: 20 + (index % 20) * 340, y: 20 + Math.floor(index / 20) * 280, width: 320, height: 260 },
      zIndex: index + 1,
      url,
      title: `Artículo número ${index} — Café São Paulo`,
      history: { entries: Array.from({ length: 20 }, (_, entry) => ({ url: `${url}&page=${entry}`, title: `Página ${entry}` })), index: 19 },
      suspended: false,
      presentation: 'normal' as const,
      positionLocked: false,
      pin: { sidebar: index % 50 === 0, viewport: null },
      createdAt: timestamp,
      updatedAt: timestamp
    };
  });
  const stacks = Array.from({ length: 10 }, (_, index) => {
    const zoneId = zones[index]!.id;
    const members = browsers.filter((browser) => browser.zoneId === zoneId).slice(0, 3);
    for (const member of members) member.worldRect = { ...members[0]!.worldRect };
    return { id: randomUUID(), zoneId, browserIds: members.map((member) => member.id), createdAt: timestamp, updatedAt: timestamp };
  });
  return {
    schemaVersion: 2,
    profiles: [{ id: profileId, name: 'Personal', kind: 'persistent', createdAt: timestamp, updatedAt: timestamp }],
    browsers,
    zones,
    stacks,
    browserOrder: browsers.map((browser) => browser.id),
    preferences: { snapEnabled: true, historySwipeEnabled: false },
    camera: { panX: 0, panY: 0, zoom: 0.8 },
    selectedBrowserId: browsers[0]!.id,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

const model = new WorkspaceModel(workspaceFile());
const snapshot: WorkspaceSnapshot = model.toSnapshot(new Map(), 'saved');
const viewport = { x: 280, y: 60, width: 1160, height: 812 };
const cards: CanvasCard[] = snapshot.browsers.map((browser) => ({ id: browser.id, worldRect: browser.worldRect, zIndex: browser.zIndex, suspended: false, crashed: false }));
const occluders = [{ x: 1266, y: 754, width: 160, height: 104 }, { x: 293, y: 830, width: 108, height: 29 }];
const layout = computeCanvasLayout(cards, snapshot.camera, viewport, occluders);
const rawLayout = JSON.parse(JSON.stringify({ items: layout.items })) as unknown;
const tree = buildSidebarTreeIndex(snapshot);
const query = normalizeSidebarSearch('número 499');
const targets = snapshot.browsers.slice(1).map((browser) => browser.worldRect);
const loading: BrowserSnapshot = { ...snapshot.browsers[250]!, title: 'Cargando…', runtime: { ...snapshot.browsers[250]!.runtime, isLoading: true } };

describe('renderer derivations with 500 browsers', () => {
  it('measures', () => {
    measure('buildSidebarTreeIndex', () => { buildSidebarTreeIndex(snapshot); });
    measure('sidebar search filter (one keystroke)', () => { tree.orderedBrowsers.filter((browser) => browserMatchesSidebarSearch(browser, query)); });
    measure('computeCanvasLayout', () => { computeCanvasLayout(cards, snapshot.camera, viewport, occluders); });
    measure('snapMovedWorldRect against 499 cards (one pointer move)', () => { snapMovedWorldRect(snapshot.browsers[0]!.worldRect, targets, 0.8); });
    measure('mergeBrowserState (one runtime event)', () => { mergeBrowserState(snapshot, loading); });
    measure('layout batch key (JSON.stringify)', () => { JSON.stringify({ items: layout.items }); });
  });
});

describe('main-process work with 500 browsers', () => {
  it('measures', () => {
    measure('commit-layout input validation (layoutBatchSchema)', () => { layoutBatchSchema.parse(rawLayout); });
    measure('WorkspaceModel.commitLayout (unchanged geometry)', () => { model.commitLayout({ items: layout.items }); });
    measure('WorkspaceModel.toSnapshot', () => { model.toSnapshot(new Map(), 'saved'); });
    measure('toPersistentFile + serializeWorkspace (20 history entries each)', () => { serializeWorkspace(model.toPersistentFile()); });
  });
});
