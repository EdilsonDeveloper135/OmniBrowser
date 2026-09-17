import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import electronExecutable from 'electron';

// Machine-specific measurements for before/after comparisons. They are observations, not CI gates.

const repositoryRoot = process.cwd();
const outputDirectory = path.join(repositoryRoot, 'test-results', 'perf');
const label = process.env.OMNIBROWSER_PERF_LABEL ?? 'run';
const results: Record<string, unknown> = {
  label,
  capturedAt: new Date().toISOString(),
  electron: '',
  machine: { platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, memoryBytes: os.totalmem(), release: os.release() }
};

let server: Server;
let origin = '';
const temporaryDirectories: string[] = [];

interface Launched {
  app: ElectronApplication;
  shell: Page;
  userData: string;
}

function html(title: string, script = ''): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{margin:0;font:14px system-ui;background:#fff}main{padding:16px}</style></head><body><main><h1>${title}</h1><p>${'Lorem ipsum dolor sit amet. '.repeat(40)}</p></main><script>${script}</script></body></html>`;
}

function seededWorkspace(count: number, pathname: string) {
  const timestamp = new Date().toISOString();
  const profileId = randomUUID();
  const browsers = Array.from({ length: count }, (_, index) => ({
    id: randomUUID(),
    profileId,
    worldRect: { x: 20 + (index % 4) * 340, y: 20 + Math.floor(index / 4) * 280, width: 320, height: 260 },
    zIndex: index + 1,
    url: `${origin}${pathname}?card=${index}`,
    title: `Card ${index}`,
    history: { entries: [{ url: `${origin}${pathname}?card=${index}`, title: `Card ${index}` }], index: 0 },
    suspended: false,
    createdAt: timestamp,
    updatedAt: timestamp
  }));
  return {
    schemaVersion: 1,
    profiles: [{ id: profileId, name: 'Personal', kind: 'persistent', createdAt: timestamp, updatedAt: timestamp }],
    browsers,
    camera: { panX: 0, panY: 0, zoom: 0.8 },
    selectedBrowserId: browsers[0]?.id ?? null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

async function launch(workspace: unknown): Promise<Launched> {
  const userData = mkdtempSync(path.join(os.tmpdir(), 'omnibrowser-perf-'));
  temporaryDirectories.push(userData);
  mkdirSync(userData, { recursive: true });
  writeFileSync(path.join(userData, 'workspace.json'), JSON.stringify(workspace));
  const app = await electron.launch({
    executablePath: electronExecutable as unknown as string,
    args: [path.join('.webpack', process.arch, 'main', 'index.js')],
    cwd: repositoryRoot,
    env: { ...process.env, NODE_ENV: 'production', OMNIBROWSER_E2E: '1', OMNIBROWSER_E2E_USER_DATA: userData },
    timeout: 30_000
  });
  await expect.poll(() => app.windows().map((candidate) => candidate.url()), { timeout: 20_000 }).toContain('omnibrowser://app/index.html');
  const shell = app.windows().find((candidate) => candidate.url() === 'omnibrowser://app/index.html')!;
  await shell.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900, false));
  results.electron = await app.evaluate(() => process.versions.electron);
  await instrument(app);
  return { app, shell, userData };
}

async function instrument(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow, WebContentsView, ipcMain }) => {
    type Counters = { invokes: Record<string, number>; events: Record<string, number>; setBounds: number; setVisible: number; workspaceWrites: number };
    const globalState = globalThis as unknown as { __omniPerf: Counters };
    globalState.__omniPerf = { invokes: {}, events: {}, setBounds: 0, setVisible: 0, workspaceWrites: 0 };
    const counters = globalState.__omniPerf;
    const shell = BrowserWindow.getAllWindows()[0]!.webContents;
    const send = shell.send.bind(shell);
    shell.send = (channel: string, ...args: unknown[]) => {
      const type = (args[0] as { type?: string } | undefined)?.type ?? channel;
      counters.events[type] = (counters.events[type] ?? 0) + 1;
      send(channel, ...args);
    };
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers;
    if (handlers) {
      for (const [channel, handler] of handlers) {
        handlers.set(channel, (...args: unknown[]) => {
          counters.invokes[channel] = (counters.invokes[channel] ?? 0) + 1;
          return handler(...args);
        });
      }
    }
    const viewPrototype = Object.getPrototypeOf(WebContentsView.prototype) as { setBounds: (...args: unknown[]) => unknown; setVisible: (...args: unknown[]) => unknown };
    const setBounds = viewPrototype.setBounds;
    const setVisible = viewPrototype.setVisible;
    viewPrototype.setBounds = function countedSetBounds(this: unknown, ...args: unknown[]) { counters.setBounds += 1; return setBounds.apply(this, args); };
    viewPrototype.setVisible = function countedSetVisible(this: unknown, ...args: unknown[]) { counters.setVisible += 1; return setVisible.apply(this, args); };
    const getBuiltinModule = (process as unknown as { getBuiltinModule: (id: string) => Record<string, unknown> }).getBuiltinModule;
    const fsPromises = getBuiltinModule('node:fs/promises') as { rename: (from: string, to: string) => Promise<void> };
    const rename = fsPromises.rename;
    fsPromises.rename = async (from: string, to: string) => {
      if (String(to).endsWith('workspace.json')) counters.workspaceWrites += 1;
      return rename(from, to);
    };
  });
}

async function resetCounters(app: ElectronApplication) {
  await app.evaluate(() => {
    const counters = (globalThis as unknown as { __omniPerf: Record<string, unknown> }).__omniPerf;
    counters.invokes = {};
    counters.events = {};
    counters.setBounds = 0;
    counters.setVisible = 0;
    counters.workspaceWrites = 0;
    return null;
  });
}

async function readCounters(app: ElectronApplication) {
  return app.evaluate(() => structuredClone((globalThis as unknown as { __omniPerf: unknown }).__omniPerf));
}

async function metrics(app: ElectronApplication) {
  return app.evaluate(({ app: electronApp, BrowserWindow }) => {
    const processes = electronApp.getAppMetrics();
    const window = BrowserWindow.getAllWindows()[0];
    const views = window ? window.contentView.children : [];
    return {
      processCount: processes.length,
      totalWorkingSetKiB: processes.reduce((total, metric) => total + metric.memory.workingSetSize, 0),
      totalCpuPercent: Number(processes.reduce((total, metric) => total + metric.cpu.percentCPUUsage, 0).toFixed(2)),
      byType: processes.reduce<Record<string, { count: number; workingSetKiB: number; cpuPercent: number }>>((summary, metric) => {
        const bucket = summary[metric.type] ?? { count: 0, workingSetKiB: 0, cpuPercent: 0 };
        bucket.count += 1;
        bucket.workingSetKiB += metric.memory.workingSetSize;
        bucket.cpuPercent = Number((bucket.cpuPercent + metric.cpu.percentCPUUsage).toFixed(2));
        summary[metric.type] = bucket;
        return summary;
      }, {}),
      nativeViews: views.length,
      visibleNativeViews: views.filter((view) => view.getVisible()).length
    };
  });
}

async function measureWindow(launched: Launched, durationMs: number, action?: () => Promise<void>) {
  await metrics(launched.app);
  await resetCounters(launched.app);
  const started = Date.now();
  if (action) await action();
  const remaining = durationMs - (Date.now() - started);
  if (remaining > 0) await launched.shell.waitForTimeout(remaining);
  const elapsedMs = Date.now() - started;
  const sample = await metrics(launched.app);
  return { elapsedMs, ...sample, counters: await readCounters(launched.app) };
}

async function nativeAlignment(launched: Launched) {
  const dom = await launched.shell.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-browser-content]')].map((element) => {
    const rect = element.getBoundingClientRect();
    return { id: element.dataset.browserContent, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  }));
  const native = await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children
    .filter((view) => view.getVisible())
    .map((view) => view.getBounds()));
  let worst = 0;
  for (const bounds of native) {
    const distances = dom.map((rect) => Math.max(
      Math.abs(rect.left - bounds.x),
      Math.abs(rect.top - bounds.y),
      Math.abs(rect.right - (bounds.x + bounds.width)),
      Math.abs(rect.bottom - (bounds.y + bounds.height))
    ));
    worst = Math.max(worst, Math.min(...distances));
  }
  return { visibleNativeViews: native.length, worstEdgeErrorPx: Number(worst.toFixed(2)) };
}

async function waitForLoadedViews(launched: Launched, expected: number) {
  await expect.poll(async () => launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children
    .filter((view) => {
      const contents = (view as unknown as { webContents: Electron.WebContents }).webContents;
      return !contents.isDestroyed() && !contents.isLoading() && contents.getURL().includes('card=');
    }).length), { timeout: 20_000 }).toBeGreaterThanOrEqual(expected);
  await launched.shell.waitForTimeout(1500);
}

async function pagePointerGesture(shell: Page, selector: string, start: { x: number; y: number }, delta: { x: number; y: number }, frames: number) {
  await shell.evaluate(async ({ selector: targetSelector, start: from, delta: by, frames: frameCount }) => {
    const target = document.querySelector(targetSelector);
    if (!target) throw new Error(`Missing ${targetSelector}`);
    const init = { bubbles: true, cancelable: true, composed: true, pointerId: 11, pointerType: 'mouse', isPrimary: true, button: 0 };
    target.dispatchEvent(new PointerEvent('pointerdown', { ...init, buttons: 1, clientX: from.x, clientY: from.y }));
    for (let frame = 1; frame <= frameCount; frame += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      window.dispatchEvent(new PointerEvent('pointermove', { ...init, buttons: 1, clientX: from.x + (by.x * frame) / frameCount, clientY: from.y + (by.y * frame) / frameCount }));
    }
    window.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0, clientX: from.x + by.x, clientY: from.y + by.y }));
  }, { selector, start, delta, frames });
}

async function closeApp(launched: Launched) {
  await launched.app.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
  await launched.app.close().catch(() => undefined);
}

test.describe.serial('OmniBrowser performance observations', () => {
  test.beforeAll(async () => {
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.setHeader('cache-control', 'no-store');
      if (url.pathname === '/clock') {
        response.end(html('Clock', 'let tick = 0; setInterval(() => { document.title = "Clock " + (tick += 1); }, 100);'));
        return;
      }
      response.end(html(`Static ${url.searchParams.get('card') ?? ''}`));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture server has no TCP port.');
    origin = `http://127.0.0.1:${address.port}`;
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
    mkdirSync(outputDirectory, { recursive: true });
    const file = path.join(outputDirectory, `${label}-${process.arch}.json`);
    writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`Performance observations written to ${file}`);
  });

  for (const count of [1, 5, 10]) {
    test(`memory lifecycle with ${count} cards`, async () => {
      test.setTimeout(120_000);
      const launched = await launch(seededWorkspace(count, '/static'));
      await waitForLoadedViews(launched, count);
      const stages: Record<string, unknown> = {};
      stages.visible = await metrics(launched.app);
      for (let step = 0; step < 4; step += 1) await launched.shell.getByRole('button', { name: 'Alejar' }).click();
      await launched.shell.waitForTimeout(1500);
      stages.hiddenSemanticZoom = await metrics(launched.app);
      for (let step = 0; step < 4; step += 1) await launched.shell.getByRole('button', { name: 'Acercar' }).click();
      await launched.shell.locator('.canvas-viewport').dispatchEvent('wheel', { deltaX: 40_000, deltaY: 0 });
      await launched.shell.waitForTimeout(1500);
      stages.offViewport = await metrics(launched.app);
      const state = await launched.shell.evaluate(() => window.omniBrowser.bootstrap());
      for (const browser of state.browsers) await launched.shell.evaluate((id) => window.omniBrowser.browsers.sleep(id), browser.id);
      await launched.shell.waitForTimeout(1500);
      stages.suspended = await metrics(launched.app);
      await launched.shell.evaluate((id) => window.omniBrowser.browsers.wake(id), state.browsers[0]!.id);
      await launched.shell.waitForTimeout(1500);
      stages.oneAwake = await metrics(launched.app);
      results[`memory-${count}`] = stages;
      await closeApp(launched);
    });
  }

  test('idle with five static cards and five ticking titles', async () => {
    test.setTimeout(120_000);
    const staticApp = await launch(seededWorkspace(5, '/static'));
    await waitForLoadedViews(staticApp, 5);
    results['idle-static-5cards-5s'] = await measureWindow(staticApp, 5000);
    await closeApp(staticApp);

    const tickingApp = await launch(seededWorkspace(5, '/clock'));
    await waitForLoadedViews(tickingApp, 5);
    results['idle-ticking-titles-5cards-5s'] = await measureWindow(tickingApp, 5000);
    await closeApp(tickingApp);
  });

  // Each gesture starts from a fresh seeded workspace so that one scenario cannot move cards for the next one.
  // The deltas keep every card fully inside the canvas and free of overlaps before and after the gesture.
  test('canvas pan interaction', async () => {
    const launched = await launch(seededWorkspace(5, '/static'));
    await waitForLoadedViews(launched, 5);
    const viewport = (await launched.shell.locator('.canvas-viewport').boundingBox())!;
    results['pan-60-frames'] = {
      ...(await measureWindow(launched, 2000, () => pagePointerGesture(launched.shell, '.canvas-viewport', { x: viewport.x + viewport.width - 60, y: viewport.y + viewport.height - 120 }, { x: 40, y: 30 }, 60))),
      alignmentAfterSettle: await nativeAlignment(launched)
    };
    await closeApp(launched);
  });

  for (const gesture of ['card-drag', 'resize'] as const) {
    test(`${gesture} interaction`, async () => {
      const launched = await launch(seededWorkspace(5, '/static'));
      await waitForLoadedViews(launched, 5);
      const card = launched.shell.locator('.browser-card').nth(4);
      const cardId = await card.getAttribute('data-browser-id');
      const selector = gesture === 'card-drag' ? `[data-browser-id="${cardId}"] .browser-card-header` : `[data-browser-id="${cardId}"] .resize-se`;
      const box = (await launched.shell.locator(selector).boundingBox())!;
      const start = gesture === 'card-drag' ? { x: box.x + 120, y: box.y + 12 } : { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      results[`${gesture}-60-frames`] = {
        ...(await measureWindow(launched, 2000, () => pagePointerGesture(launched.shell, selector, start, { x: 60, y: 40 }, 60))),
        alignmentAfterSettle: await nativeAlignment(launched)
      };
      await closeApp(launched);
    });
  }
});
