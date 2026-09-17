import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import electronExecutable from 'electron';

// Regression coverage for the runtime audit (docs/engineering-audit.md). Every test launches its own production-bundle
// instance with an isolated userData directory so that lifecycle scenarios cannot leak into each other.

const repositoryRoot = process.cwd();
const mainEntry = path.join('.webpack', process.arch, 'main', 'index.js');
const userDataDirectories: string[] = [];

let server: Server;
let origin = '';

interface Launched {
  app: ElectronApplication;
  child: ChildProcess;
  shell: Page;
  userData: string;
  output: string[];
}

interface SeedCard {
  x: number;
  y: number;
  width?: number;
  height?: number;
  url?: string;
  history?: Array<{ url: string; title: string }>;
  historyIndex?: number;
  suspended?: boolean;
}

function page(title: string, body = '', script = ''): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${title}${body}<script>${script}</script></body></html>`;
}

function seededWorkspace(cards: SeedCard[], options: { selectedIndex?: number; camera?: { panX: number; panY: number; zoom: number } } = {}) {
  const timestamp = new Date().toISOString();
  const profileId = randomUUID();
  const browsers = cards.map((card, index) => {
    const url = card.url ?? 'about:blank';
    return {
      id: randomUUID(),
      profileId,
      worldRect: { x: card.x, y: card.y, width: card.width ?? 500, height: card.height ?? 360 },
      zIndex: index + 1,
      url,
      title: `Card ${index}`,
      history: { entries: card.history ?? (url === 'about:blank' ? [] : [{ url, title: `Card ${index}` }]), index: card.historyIndex ?? Math.max(0, (card.history?.length ?? 1) - 1) },
      suspended: card.suspended ?? false,
      createdAt: timestamp,
      updatedAt: timestamp
    };
  });
  return {
    schemaVersion: 1,
    profiles: [{ id: profileId, name: 'Personal', kind: 'persistent', createdAt: timestamp, updatedAt: timestamp }],
    browsers,
    camera: options.camera ?? { panX: 0, panY: 0, zoom: 1 },
    selectedBrowserId: browsers[options.selectedIndex ?? browsers.length - 1]?.id ?? null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function newUserData(workspace?: unknown): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'omnibrowser-e2e-regression-'));
  userDataDirectories.push(directory);
  if (workspace) writeFileSync(path.join(directory, 'workspace.json'), JSON.stringify(workspace));
  return directory;
}

function launchEnvironment(userData: string): Record<string, string> {
  const inherited = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  return { ...inherited, NODE_ENV: 'production', OMNIBROWSER_E2E: '1', OMNIBROWSER_E2E_USER_DATA: userData };
}

async function launchApp(userData: string): Promise<Launched> {
  const app = await electron.launch({
    executablePath: electronExecutable as unknown as string,
    args: [mainEntry],
    cwd: repositoryRoot,
    env: launchEnvironment(userData),
    timeout: 30_000
  });
  const output: string[] = [];
  const child = app.process();
  child.stdout?.on('data', (chunk) => output.push(String(chunk)));
  child.stderr?.on('data', (chunk) => output.push(String(chunk)));
  await expect.poll(() => app.windows().map((candidate) => candidate.url()), { timeout: 20_000 }).toContain('omnibrowser://app/index.html');
  const shell = app.windows().find((candidate) => candidate.url() === 'omnibrowser://app/index.html')!;
  await shell.waitForLoadState('domcontentloaded');
  await expect(shell.getByText('OmniBrowser', { exact: true })).toBeVisible();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900, false));
  return { app, child, shell, userData, output };
}

async function closeApp(launched: Launched): Promise<void> {
  const { child } = launched;
  const exited = child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise<void>((resolve) => child.once('exit', () => resolve()));
  await launched.app.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
  await launched.app.close().catch(() => undefined);
  // Chromium keeps writing Local State and Preferences while the browser process exits; removing userData before the
  // process is gone would leave a recreated directory behind.
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
}

async function snapshot(shell: Page) {
  return shell.evaluate(() => window.omniBrowser.bootstrap());
}

async function nativeViews(app: ElectronApplication) {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.map((view) => {
    const contents = (view as unknown as { webContents: Electron.WebContents }).webContents;
    return { bounds: view.getBounds(), visible: view.getVisible(), url: contents.isDestroyed() ? '' : contents.getURL(), contentsId: contents.id };
  }));
}

async function contentRects(shell: Page) {
  return shell.evaluate(() => Object.fromEntries([...document.querySelectorAll<HTMLElement>('[data-browser-content]')].map((element) => {
    const rect = element.getBoundingClientRect();
    return [element.dataset.browserContent!, { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }];
  })));
}

/** Every visible native view must sit on its card's content slot within one DIP. */
async function expectNativeViewsAligned(launched: Launched, expectedVisible: number): Promise<void> {
  await expect.poll(async () => {
    const [views, rects] = await Promise.all([nativeViews(launched.app), contentRects(launched.shell)]);
    const visible = views.filter((view) => view.visible);
    if (visible.length !== expectedVisible) return `visible=${visible.length}`;
    const worst = Math.max(0, ...visible.map((view) => Math.min(...Object.values(rects).map((rect) => Math.max(
      Math.abs(rect.left - view.bounds.x),
      Math.abs(rect.top - view.bounds.y),
      Math.abs(rect.right - (view.bounds.x + view.bounds.width)),
      Math.abs(rect.bottom - (view.bounds.y + view.bounds.height))
    )))));
    return worst <= 1 ? 'aligned' : `error=${worst}`;
  }, { timeout: 5000 }).toBe('aligned');
}

async function dispatchDrag(shell: Page, selector: string, start: { x: number; y: number }, delta: { x: number; y: number }): Promise<void> {
  await shell.evaluate(async ({ targetSelector, from, by }) => {
    const target = document.querySelector(targetSelector)!;
    const init = { bubbles: true, cancelable: true, composed: true, pointerId: 21, pointerType: 'mouse', isPrimary: true, button: 0 };
    target.dispatchEvent(new PointerEvent('pointerdown', { ...init, buttons: 1, clientX: from.x, clientY: from.y }));
    for (let frame = 1; frame <= 12; frame += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      window.dispatchEvent(new PointerEvent('pointermove', { ...init, buttons: 1, clientX: from.x + (by.x * frame) / 12, clientY: from.y + (by.y * frame) / 12 }));
    }
    window.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0, clientX: from.x + by.x, clientY: from.y + by.y }));
  }, { targetSelector: selector, from: start, by: delta });
}

async function submitUrl(shell: Page, url: string): Promise<void> {
  const input = shell.getByRole('textbox', { name: 'URL' });
  await input.fill(url);
  await input.evaluate((element) => (element as HTMLInputElement).form!.requestSubmit());
}

async function openBrowserMenu(shell: Page, browserId: string) {
  const menu = shell.locator(`[data-browser-id="${browserId}"] .card-menu`);
  if (await menu.getAttribute('open') === null) await menu.locator('summary').click();
  await expect(menu.locator('.card-menu-popover')).toBeVisible();
  return menu;
}

async function remoteEval<T>(app: ElectronApplication, urlFragment: string, source: string): Promise<T> {
  return app.evaluate(async ({ webContents }, { fragment, code }) => {
    const target = webContents.getAllWebContents().find((contents) => contents.getURL().includes(fragment));
    if (!target) throw new Error(`No WebContents for ${fragment}`);
    return target.executeJavaScript(code, true) as Promise<T>;
  }, { fragment: urlFragment, code: source });
}

function mainProcessNoise(output: string[]): string[] {
  return output.join('').split('\n').filter((line) => /Error occurred in handler|ZodError|Error inesperado|UnhandledPromiseRejection|A JavaScript error/.test(line));
}

test.beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    switch (url.pathname) {
      case '/clock':
        response.end(page('Clock', '', 'let tick = 0; setInterval(() => { document.title = "Clock " + (tick += 1); }, 100);'));
        return;
      case '/long':
        response.end(page('Long', '', `location.replace('/one?' + 'q'.repeat(4300));`));
        return;
      case '/links':
        response.end(page('Links', '<a id="noopener" href="/one?from=noopener" target="_blank">a</a><a id="opener" href="/one?from=opener" target="_blank" rel="opener">b</a>'));
        return;
      case '/mailto-loop':
        response.end(page('Mailto loop', '', 'let count = 0; const loop = () => { if (count++ < 20) { location.href = "mailto:someone@example.com"; setTimeout(loop, 50); } }; loop();'));
        return;
      case '/slow':
        setTimeout(() => response.end(page('Slow')), 2500);
        return;
      default:
        response.end(page(url.pathname === '/two' ? 'Two' : 'One'));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('The fixture server did not expose a TCP port.');
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const directory of userDataDirectories) {
    if (path.resolve(directory).startsWith(`${tmpdir()}${path.sep}omnibrowser-e2e-regression-`)) rmSync(directory, { recursive: true, force: true });
  }
});

test('native views stay aligned with their cards through pan, wheel, drag and resize', async () => {
  const launched = await launchApp(newUserData(seededWorkspace([{ x: 40, y: 40 }, { x: 600, y: 40 }])));
  await expectNativeViewsAligned(launched, 2);
  const viewport = (await launched.shell.locator('.canvas-viewport').boundingBox())!;

  await dispatchDrag(launched.shell, '.canvas-viewport', { x: viewport.x + 400, y: viewport.y + 700 }, { x: 60, y: 45 });
  await expect.poll(async () => (await snapshot(launched.shell)).camera.panX).toBe(60);
  await expectNativeViewsAligned(launched, 2);

  await launched.shell.locator('.canvas-viewport').dispatchEvent('wheel', { deltaX: 25, deltaY: 30 });
  await expectNativeViewsAligned(launched, 2);

  const cardId = (await snapshot(launched.shell)).browsers[0]!.id;
  const header = (await launched.shell.locator(`[data-browser-id="${cardId}"] .browser-card-header`).boundingBox())!;
  await dispatchDrag(launched.shell, `[data-browser-id="${cardId}"] .browser-card-header`, { x: header.x + 100, y: header.y + 15 }, { x: 20, y: 30 });
  await expectNativeViewsAligned(launched, 2);

  const handle = (await launched.shell.locator(`[data-browser-id="${cardId}"] .resize-se`).boundingBox())!;
  await dispatchDrag(launched.shell, `[data-browser-id="${cardId}"] .resize-se`, { x: handle.x + 7, y: handle.y + 7 }, { x: -60, y: 50 });
  await expectNativeViewsAligned(launched, 2);
  expect(mainProcessNoise(launched.output)).toEqual([]);
  await closeApp(launched);
});

test('Chromium surfaces never cover a higher card, the minimap or a visible notice', async () => {
  const launched = await launchApp(newUserData(seededWorkspace([{ x: 40, y: 40 }, { x: 140, y: 110 }, { x: 650, y: 400 }], { selectedIndex: 1 })));
  const state = await snapshot(launched.shell);
  const [lower, upper, corner] = state.browsers;
  await expect.poll(async () => (await nativeViews(launched.app)).filter((view) => view.visible).length).toBe(2);

  const coverage = async () => {
    const views = (await nativeViews(launched.app)).filter((view) => view.visible);
    return launched.shell.evaluate((visible) => {
      const intersects = (a: DOMRect, b: { x: number; y: number; width: number; height: number }) => a.left < b.x + b.width && a.right > b.x && a.top < b.y + b.height && a.bottom > b.y;
      const upperCard = [...document.querySelectorAll<HTMLElement>('.browser-card')].sort((a, b) => Number(b.style.zIndex) - Number(a.style.zIndex))[0]!;
      const header = upperCard.querySelector('.browser-card-header')!.getBoundingClientRect();
      const minimap = document.querySelector<HTMLElement>('.minimap');
      return {
        headerCovered: visible.some((view) => intersects(header, view.bounds)),
        minimapHidden: minimap?.hidden ?? true,
        minimapCovered: !!minimap && !minimap.hidden && visible.some((view) => intersects(minimap.getBoundingClientRect(), view.bounds))
      };
    }, views);
  };

  expect(await coverage()).toMatchObject({ headerCovered: false, minimapCovered: false });
  expect(upper && corner).toBeTruthy();
  await launched.shell.locator(`[data-browser-id="${lower!.id}"] .browser-content-slot`).dispatchEvent('pointerdown', { button: 0, buttons: 1, pointerId: 31, pointerType: 'mouse', isPrimary: true });
  await expect.poll(async () => (await snapshot(launched.shell)).selectedBrowserId).toBe(lower!.id);
  await expect.poll(async () => (await coverage()).headerCovered).toBe(false);
  await expect.poll(async () => {
    const views = await nativeViews(launched.app);
    return views.filter((view) => view.visible).length;
  }).toBe(2);

  await expect.poll(async () => (await coverage()).minimapHidden).toBe(true);
  await submitUrl(launched.shell, 'buscar gatitos');
  await expect(launched.shell.locator('.notice-toast')).toBeVisible();
  const toast = (await launched.shell.locator('.notice-toast').boundingBox())!;
  await expect.poll(async () => (await nativeViews(launched.app)).some((view) => view.visible
    && view.bounds.x < toast.x + toast.width && view.bounds.x + view.bounds.width > toast.x
    && view.bounds.y < toast.y + toast.height && view.bounds.y + view.bounds.height > toast.y)).toBe(false);
  await launched.shell.getByRole('button', { name: 'Cerrar aviso' }).click();
  await expect.poll(async () => (await nativeViews(launched.app)).filter((view) => view.visible).length).toBe(2);
  await closeApp(launched);
});

test('startup and restore do not depend on the network', async () => {
  const unreachable = 'http://127.0.0.1:9/unreachable';
  const launched = await launchApp(newUserData(seededWorkspace([
    { x: 40, y: 40, url: unreachable, history: [{ url: `${origin}/one`, title: 'One' }, { url: unreachable, title: 'Dead' }], historyIndex: 1 }
  ])));
  const card = (await snapshot(launched.shell)).browsers[0]!;
  await expect(launched.shell.locator('.browser-card')).toHaveCount(1);
  await expect(launched.shell.locator('.notice-toast')).toContainText('No se pudo cargar 127.0.0.1');
  await expect.poll(async () => (await snapshot(launched.shell)).browsers[0]?.runtime.canGoBack).toBe(true);
  await launched.shell.getByRole('button', { name: 'Atrás' }).click();
  await expect.poll(async () => (await snapshot(launched.shell)).browsers[0]?.title).toBe('One');
  expect((await snapshot(launched.shell)).browsers[0]?.id).toBe(card.id);
  expect(mainProcessNoise(launched.output)).toEqual([]);
  await closeApp(launched);
});

test('invalid navigation input is explained in the shell without main-process exceptions', async () => {
  const launched = await launchApp(newUserData());
  const cases: Array<[string, string]> = [
    ['buscar gatitos', 'OmniBrowser no realiza búsquedas implícitas'],
    ['   ', 'Introduce una URL.'],
    [`https://example.com/${'a'.repeat(5000)}`, 'La URL supera el límite de 4096 caracteres.'],
    ['javascript:alert(1)', 'El protocolo javascript: no está permitido.'],
    ['file:///etc/passwd', 'El protocolo file: no está permitido.']
  ];
  for (const [input, message] of cases) {
    await submitUrl(launched.shell, input);
    await expect(launched.shell.locator('.notice-toast')).toContainText(message);
    await expect(launched.shell.locator('.notice-toast')).not.toContainText('"code"');
    await launched.shell.getByRole('button', { name: 'Cerrar aviso' }).click();
  }
  expect((await snapshot(launched.shell)).browsers[0]?.runtime.isLoading).toBe(false);
  expect(mainProcessNoise(launched.output)).toEqual([]);
  await closeApp(launched);
});

test('page-generated URLs longer than the persisted limit never break saving', async () => {
  const launched = await launchApp(newUserData());
  await submitUrl(launched.shell, `${origin}/long`);
  await expect.poll(async () => (await nativeViews(launched.app)).some((view) => view.url.length > 4096), { timeout: 10_000 }).toBe(true);
  await launched.shell.evaluate(() => window.omniBrowser.workspace.saveNow());
  const saved = JSON.parse(readFileSync(path.join(launched.userData, 'workspace.json'), 'utf8')) as { browsers: Array<{ url: string; history: { entries: Array<{ url: string }> } }> };
  expect(saved.browsers[0]!.url.length).toBeLessThanOrEqual(4096);
  expect(saved.browsers[0]!.history.entries.every((entry) => entry.url.length <= 4096)).toBe(true);
  await expect(launched.shell.locator('.save-indicator')).toContainText('Guardado');
  expect(mainProcessNoise(launched.output)).toEqual([]);
  await closeApp(launched);
});

test('the workspace is still written while a page keeps changing its title', async () => {
  const launched = await launchApp(newUserData());
  const file = path.join(launched.userData, 'workspace.json');
  await submitUrl(launched.shell, `${origin}/clock`);
  await expect.poll(() => {
    try { return readFileSync(file, 'utf8').includes(`${origin}/clock`); } catch { return false; }
  }, { timeout: 5000 }).toBe(true);
  const firstWrite = statSync(file).mtimeMs;
  await expect.poll(() => /"title": "Clock \d+"/.test(readFileSync(file, 'utf8')) && statSync(file).mtimeMs > firstWrite, { timeout: 9000 }).toBe(true);
  await closeApp(launched);
});

test('cards opened with target=_blank are adopted and survive their opener being suspended or closed', async () => {
  const launched = await launchApp(newUserData());
  await submitUrl(launched.shell, `${origin}/links`);
  await expect.poll(async () => (await snapshot(launched.shell)).browsers[0]?.title).toBe('Links');
  const opener = (await snapshot(launched.shell)).browsers[0]!;
  await remoteEval(launched.app, '/links', 'document.getElementById("noopener").click(); document.getElementById("opener").click(); true');
  await expect(launched.shell.locator('.browser-card')).toHaveCount(3);
  const popups = (await snapshot(launched.shell)).browsers.filter((browser) => browser.id !== opener.id);
  expect(popups.every((browser) => browser.profileId === opener.profileId)).toBe(true);

  await launched.shell.evaluate((id) => window.omniBrowser.browsers.sleep(id), opener.id);
  await launched.shell.waitForTimeout(800);
  await expect(launched.shell.locator('.browser-card')).toHaveCount(3);
  await launched.shell.evaluate((id) => window.omniBrowser.browsers.close(id), opener.id);
  await launched.shell.waitForTimeout(800);
  expect((await snapshot(launched.shell)).browsers.map((browser) => browser.id).sort()).toEqual(popups.map((browser) => browser.id).sort());
  await closeApp(launched);
});

test('pressing inside a page selects its card, but programmatic focus cannot steal the selection', async () => {
  const launched = await launchApp(newUserData(seededWorkspace([{ x: 40, y: 40, url: `${origin}/one` }, { x: 600, y: 40, url: `${origin}/two` }], { selectedIndex: 1 })));
  const initial = await snapshot(launched.shell);
  const second = initial.browsers[1]!;
  await expect.poll(async () => (await nativeViews(launched.app)).filter((view) => view.visible && !view.url.startsWith('about:')).length).toBe(2);
  const first = (await snapshot(launched.shell)).browsers.find((browser) => browser.url.includes('/one'))!;

  // Neither WebContents.focus() nor a page calling window.focus() is user input.
  await launched.app.evaluate(async ({ webContents }) => {
    const page = webContents.getAllWebContents().find((contents) => contents.getURL().includes('/one'))!;
    page.focus();
    await page.executeJavaScript('window.focus(); document.body.focus(); true', true);
  });
  await launched.shell.waitForTimeout(600);
  expect((await snapshot(launched.shell)).selectedBrowserId).toBe(second.id);

  await launched.app.evaluate(({ webContents }) => {
    const page = webContents.getAllWebContents().find((contents) => contents.getURL().includes('/one'))!;
    page.sendInputEvent({ type: 'mouseDown', x: 40, y: 40, button: 'left', clickCount: 1 });
    page.sendInputEvent({ type: 'mouseUp', x: 40, y: 40, button: 'left', clickCount: 1 });
  });
  await expect.poll(async () => (await snapshot(launched.shell)).selectedBrowserId).toBe(first.id);
  await expect(launched.shell.locator(`[data-browser-id="${first.id}"]`)).toHaveClass(/is-selected/);
  const ordered = (await snapshot(launched.shell)).browsers.sort((a, b) => b.zIndex - a.zIndex);
  expect(ordered[0]?.id).toBe(first.id);
  await closeApp(launched);
});

test('a page looping external protocol navigations cannot flood the workspace with dialogs', async () => {
  const launched = await launchApp(newUserData());
  await launched.app.evaluate(({ dialog }) => {
    const state = globalThis as unknown as { __externalPrompts: number };
    state.__externalPrompts = 0;
    dialog.showMessageBox = (async () => {
      state.__externalPrompts += 1;
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { response: 0, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  });
  await submitUrl(launched.shell, `${origin}/mailto-loop`);
  await launched.shell.waitForTimeout(2500);
  expect(await launched.app.evaluate(() => (globalThis as unknown as { __externalPrompts: number }).__externalPrompts)).toBe(1);
  await closeApp(launched);
});

test('a crashed page is hidden and can be recovered from its card', async () => {
  const launched = await launchApp(newUserData(seededWorkspace([{ x: 40, y: 40, url: `${origin}/one` }])));
  await expect.poll(async () => (await nativeViews(launched.app)).some((view) => view.visible && view.url.includes('/one'))).toBe(true);
  await launched.app.evaluate(({ webContents }) => {
    webContents.getAllWebContents().find((contents) => contents.getURL().includes('/one'))!.forcefullyCrashRenderer();
  });
  const card = launched.shell.locator('.browser-card').first();
  await expect(card.getByText('La vista dejó de responder')).toBeVisible();
  await expect.poll(async () => (await nativeViews(launched.app)).some((view) => view.visible)).toBe(false);
  await card.locator('.browser-placeholder').getByRole('button', { name: 'Recargar' }).click();
  await expect.poll(async () => (await snapshot(launched.shell)).browsers[0]?.runtime.crashed).toBe(false);
  await expect.poll(async () => (await nativeViews(launched.app)).some((view) => view.visible && view.url.includes('/one'))).toBe(true);
  await closeApp(launched);
});

test('repeated wake, sleep and close requests never duplicate or leak views', async () => {
  const launched = await launchApp(newUserData(seededWorkspace([{ x: 40, y: 40, url: `${origin}/slow`, suspended: true }, { x: 600, y: 40 }], { selectedIndex: 1 })));
  const [slow] = (await snapshot(launched.shell)).browsers;
  const liveContents = () => launched.app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((contents) => !contents.getURL().startsWith('omnibrowser://')).length);
  await launched.shell.evaluate(async (id) => {
    await Promise.all([window.omniBrowser.browsers.wake(id), window.omniBrowser.browsers.wake(id), window.omniBrowser.browsers.wake(id)]);
  }, slow!.id);
  await expect.poll(liveContents).toBe(2);
  await launched.shell.evaluate(async (id) => {
    await window.omniBrowser.browsers.sleep(id);
    await window.omniBrowser.browsers.wake(id);
    await window.omniBrowser.browsers.sleep(id);
    await window.omniBrowser.browsers.wake(id);
  }, slow!.id);
  await expect.poll(liveContents).toBe(2);
  await launched.shell.evaluate((id) => window.omniBrowser.browsers.close(id), slow!.id);
  await expect.poll(liveContents).toBe(1);
  await launched.shell.waitForTimeout(3000);
  expect((await snapshot(launched.shell)).browsers).toHaveLength(1);
  expect(await liveContents()).toBe(1);
  expect(mainProcessNoise(launched.output)).toEqual([]);
  await closeApp(launched);
});

test('restart creates the selected card first and only the visible ones, keeping the selection', async () => {
  const cards: SeedCard[] = [
    { x: 40, y: 40, url: `${origin}/one?visible=1` },
    { x: 600, y: 40, url: `${origin}/one?visible=2` },
    { x: 8000, y: 8000, url: `${origin}/one?offscreen=1` },
    { x: 9000, y: 9000, url: `${origin}/one?offscreen=2` },
    { x: 12_000, y: 0, url: `${origin}/one?selected-offscreen=1` }
  ];
  const launched = await launchApp(newUserData(seededWorkspace(cards, { selectedIndex: 4 })));
  const selectedId = (await snapshot(launched.shell)).selectedBrowserId;
  await expect.poll(async () => (await nativeViews(launched.app)).map((view) => view.url ? new URL(view.url).search : '(loading)').sort()).toEqual(['?selected-offscreen=1', '?visible=1', '?visible=2']);
  await launched.shell.waitForTimeout(1000);
  expect((await snapshot(launched.shell)).selectedBrowserId).toBe(selectedId);
  expect(await nativeViews(launched.app)).toHaveLength(3);
  await closeApp(launched);
});

test('quitting persists pending changes and terminates the process', async () => {
  const userData = newUserData();
  const launched = await launchApp(userData);
  const profileId = (await snapshot(launched.shell)).profiles.find((profile) => profile.kind === 'persistent')!.id;
  await launched.shell.evaluate((id) => window.omniBrowser.browsers.create(id), profileId);
  const expectedIds = (await snapshot(launched.shell)).browsers.map((browser) => browser.id).sort();
  const pid = launched.child.pid!;
  await launched.app.evaluate(({ app }) => { setTimeout(() => app.quit(), 10); });
  await expect.poll(() => {
    try { process.kill(pid, 0); return 'running'; } catch { return 'exited'; }
  }, { timeout: 10_000 }).toBe('exited');
  const saved = JSON.parse(readFileSync(path.join(userData, 'workspace.json'), 'utf8')) as { browsers: Array<{ id: string }> };
  expect(saved.browsers.map((browser) => browser.id).sort()).toEqual(expectedIds);
  await closeApp(launched);
});

test('a second instance on the same userData exits and leaves the running one intact', async () => {
  const launched = await launchApp(newUserData());
  const workspaceFile = path.join(launched.userData, 'workspace.json');
  await expect.poll(() => {
    try { return readFileSync(workspaceFile, 'utf8').length > 0; } catch { return false; }
  }).toBe(true);
  const before = readFileSync(workspaceFile, 'utf8');
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(electronExecutable as unknown as string, [mainEntry], { cwd: repositoryRoot, env: launchEnvironment(launched.userData), stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('The second instance did not exit.')); }, 15_000);
    child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
  expect(exitCode).toBe(0);
  expect((await snapshot(launched.shell)).browsers).toHaveLength(1);
  expect(readFileSync(workspaceFile, 'utf8')).toBe(before);
  await closeApp(launched);
});

test('remote pages have no bridge, Node.js, shell protocol, cross-origin reads or permissions, and the shell CSP is strict', async () => {
  const launched = await launchApp(newUserData());
  await submitUrl(launched.shell, `${origin}/one`);
  await expect.poll(async () => (await snapshot(launched.shell)).browsers[0]?.title).toBe('One');
  const crossOrigin = origin.replace('127.0.0.1', 'localhost');
  const probe = await remoteEval<Record<string, unknown>>(launched.app, '/one', `(async () => ({
    bridge: typeof window.omniBrowser,
    require: typeof require,
    process: typeof process,
    webviewGuestApi: (() => { const element = document.createElement('webview'); element.setAttribute('src', '${origin}/two'); document.body.appendChild(element); return typeof element.loadURL + typeof element.getWebContentsId; })(),
    shellProtocol: await fetch('omnibrowser://app/index.html').then(() => 'loaded', () => 'blocked'),
    crossOriginRead: await fetch('${crossOrigin}/two').then((response) => response.text()).then(() => 'read', () => 'blocked'),
    notifications: await Notification.requestPermission(),
    geolocation: (await navigator.permissions.query({ name: 'geolocation' })).state
  }))()`);
  expect(probe).toEqual({ bridge: 'undefined', require: 'undefined', process: 'undefined', webviewGuestApi: 'undefinedundefined', shellProtocol: 'blocked', crossOriginRead: 'blocked', notifications: 'denied', geolocation: 'denied' });
  // The inert <webview> element above must not have produced a guest WebContents: only the shell and the page exist.
  expect(await launched.app.evaluate(({ webContents }) => webContents.getAllWebContents().length)).toBe(2);
  const shellCsp = await launched.shell.evaluate(() => new Promise<string>((resolve) => {
    document.addEventListener('securitypolicyviolation', (event) => resolve(event.effectiveDirective), { once: true });
    try { new WebSocket('ws://127.0.0.1:9/'); } catch { resolve('connect-src'); }
    setTimeout(() => resolve('allowed'), 2000);
  }));
  expect(shellCsp).toBe('connect-src');
  // Playwright evaluates through CDP, which bypasses CSP for eval, so the policy text itself is asserted instead.
  const headerPolicy = await launched.shell.evaluate(async () => (await fetch(location.href)).headers.get('content-security-policy') ?? '');
  const metaPolicy = await launched.shell.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '');
  for (const policy of [headerPolicy, metaPolicy]) {
    const scriptSource = policy.split(';').map((directive) => directive.trim()).find((directive) => directive.startsWith('script-src ')) ?? '';
    expect(scriptSource).toBe("script-src 'self'");
  }
  expect(headerPolicy).toContain("connect-src 'self'");
  expect(headerPolicy).not.toContain('ws:');
  await closeApp(launched);
});

test('the canvas can be panned and zoomed from the keyboard', async () => {
  const launched = await launchApp(newUserData(seededWorkspace([{ x: 40, y: 40 }])));
  const canvas = launched.shell.locator('.canvas-viewport');
  await canvas.focus();
  await canvas.press('ArrowRight');
  await canvas.press('Shift+ArrowUp');
  await expect.poll(async () => (await snapshot(launched.shell)).camera).toMatchObject({ panX: -40, panY: 200, zoom: 1 });
  await canvas.press('-');
  await expect.poll(async () => (await snapshot(launched.shell)).camera.zoom).toBe(0.9);
  await canvas.press('0');
  await expect.poll(async () => (await snapshot(launched.shell)).camera.zoom).toBe(1);
  await expectNativeViewsAligned(launched, 1);
  await closeApp(launched);
});

test('fullscreen, minimize, lock, viewport pin and duplicate preserve canonical world geometry', async () => {
  const launched = await launchApp(newUserData(seededWorkspace([{ x: 80, y: 70, url: `${origin}/one` }])));
  const initial = await snapshot(launched.shell);
  const browser = initial.browsers[0]!;
  const originalRect = browser.worldRect;
  const originalCamera = initial.camera;

  await (await openBrowserMenu(launched.shell, browser.id)).getByRole('button', { name: 'Pantalla completa' }).click();
  await expect(launched.shell.locator('.app-shell')).toHaveClass(/is-immersive/);
  await expect(launched.shell.locator('.profile-rail')).toBeHidden();
  await expect(launched.shell.locator(`[data-browser-id="${browser.id}"]`)).toHaveClass(/surface-immersive/);
  await expectNativeViewsAligned(launched, 1);
  expect((await snapshot(launched.shell)).browsers[0]!.worldRect).toEqual(originalRect);
  expect((await snapshot(launched.shell)).camera).toEqual(originalCamera);

  await launched.app.evaluate(({ webContents }) => {
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL().includes('/one'));
    if (!contents) throw new Error('Missing immersive WebContents.');
    contents.focus();
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  });
  await expect(launched.shell.locator('.app-shell')).not.toHaveClass(/is-immersive/);
  await expect(launched.shell.locator('.profile-rail')).toBeVisible();
  expect((await snapshot(launched.shell)).browsers[0]!.worldRect).toEqual(originalRect);

  await (await openBrowserMenu(launched.shell, browser.id)).getByRole('button', { name: 'Minimizar' }).click();
  await expect.poll(async () => (await snapshot(launched.shell)).browsers[0]?.presentation).toBe('minimized');
  await expect(launched.shell.locator(`[data-browser-id="${browser.id}"]`)).toHaveClass(/minimized-browser-card/);
  await expect.poll(async () => (await nativeViews(launched.app)).filter((view) => view.visible).length).toBe(0);
  expect((await snapshot(launched.shell)).browsers[0]!.worldRect).toEqual(originalRect);
  await launched.shell.getByRole('button', { name: 'Restaurar navegador' }).click();
  await expect.poll(async () => (await snapshot(launched.shell)).browsers[0]?.presentation).toBe('normal');
  await expectNativeViewsAligned(launched, 1);

  await (await openBrowserMenu(launched.shell, browser.id)).getByRole('button', { name: 'Bloquear posición' }).click();
  await expect.poll(async () => (await snapshot(launched.shell)).browsers[0]?.positionLocked).toBe(true);
  await expect(launched.shell.locator(`[data-browser-id="${browser.id}"] .resize-handle`)).toHaveCount(0);
  const lockedHeader = (await launched.shell.locator(`[data-browser-id="${browser.id}"] .browser-card-header`).boundingBox())!;
  await dispatchDrag(launched.shell, `[data-browser-id="${browser.id}"] .browser-card-header`, { x: lockedHeader.x + 80, y: lockedHeader.y + 18 }, { x: 90, y: 60 });
  expect((await snapshot(launched.shell)).browsers[0]!.worldRect).toEqual(originalRect);
  await (await openBrowserMenu(launched.shell, browser.id)).getByRole('button', { name: 'Desbloquear' }).click();

  await (await openBrowserMenu(launched.shell, browser.id)).getByRole('button', { name: 'Fijar al viewport' }).click();
  await expect.poll(async () => (await snapshot(launched.shell)).browsers[0]?.pin.viewport).not.toBeNull();
  await expect(launched.shell.locator(`[data-browser-id="${browser.id}"]`)).toHaveClass(/surface-pinned/);
  const pinnedBefore = (await launched.shell.locator(`[data-browser-id="${browser.id}"]`).boundingBox())!;
  await launched.shell.locator('.canvas-viewport').dispatchEvent('wheel', { deltaX: 140, deltaY: 90 });
  const pinnedAfter = (await launched.shell.locator(`[data-browser-id="${browser.id}"]`).boundingBox())!;
  expect(pinnedAfter).toEqual(pinnedBefore);
  expect((await snapshot(launched.shell)).browsers[0]!.worldRect).toEqual(originalRect);
  await (await openBrowserMenu(launched.shell, browser.id)).getByRole('button', { name: 'Desanclar del viewport' }).click();
  await expect.poll(async () => (await snapshot(launched.shell)).browsers[0]?.pin.viewport).toBeNull();

  await (await openBrowserMenu(launched.shell, browser.id)).getByRole('button', { name: 'Duplicar' }).click();
  await expect.poll(async () => (await snapshot(launched.shell)).browsers.length).toBe(2);
  const duplicated = (await snapshot(launched.shell)).browsers.find((candidate) => candidate.id !== browser.id)!;
  expect(duplicated).toMatchObject({
    profileId: browser.profileId,
    presentation: 'normal',
    positionLocked: false,
    pin: { sidebar: false, viewport: null }
  });
  expect(duplicated.worldRect).toEqual({ ...originalRect, x: originalRect.x + 32, y: originalRect.y + 24 });
  expect(mainProcessNoise(launched.output)).toEqual([]);
  await closeApp(launched);
});

test('zones collapse native views and stacks expose only their selected top member', async () => {
  const launched = await launchApp(newUserData(seededWorkspace([
    { x: 40, y: 40, url: `${origin}/one` },
    { x: 600, y: 40, url: `${origin}/two` }
  ])));
  const initial = await snapshot(launched.shell);
  const ids = initial.browsers.map((browser) => browser.id);
  const profileId = initial.profiles.find((profile) => profile.kind === 'persistent')!.id;
  await launched.shell.evaluate(({ targetProfileId, browserIds }) => window.omniBrowser.workspace.createZone(targetProfileId, 'Research', '#336699', browserIds), { targetProfileId: profileId, browserIds: ids });
  await expect.poll(async () => (await snapshot(launched.shell)).zones[0]?.name).toBe('Research');
  await expect(launched.shell.locator('.zone-frame')).toBeVisible();
  await expect(launched.shell.locator('.zone-name-button', { hasText: 'Research' })).toBeVisible();
  await expectNativeViewsAligned(launched, 2);

  await launched.shell.locator('.zone-name-button', { hasText: 'Research' }).click();
  await expect.poll(async () => (await snapshot(launched.shell)).zones[0]?.collapsed).toBe(true);
  await expect(launched.shell.locator('.collapsed-zone-chip')).toContainText('2');
  await expect(launched.shell.locator('.browser-card')).toHaveCount(0);
  await expect.poll(async () => (await nativeViews(launched.app)).filter((view) => view.visible).length).toBe(0);
  await launched.shell.locator(`[data-minimap-browser="${ids[0]}"]`).click();
  await expect.poll(async () => (await snapshot(launched.shell)).zones[0]?.collapsed).toBe(false);
  await expect(launched.shell.locator('.browser-card')).toHaveCount(2);
  await expect.poll(async () => (await snapshot(launched.shell)).selectedBrowserId).toBe(ids[0]);
  await expect.poll(async () => (await snapshot(launched.shell)).camera.zoom).toBeGreaterThanOrEqual(0.5);

  const zoneId = (await snapshot(launched.shell)).zones[0]!.id;
  await launched.shell.evaluate(({ targetZoneId, browserIds }) => window.omniBrowser.workspace.createStack(targetZoneId, browserIds), { targetZoneId: zoneId, browserIds: ids });
  await expect.poll(async () => (await snapshot(launched.shell)).stacks).toHaveLength(1);
  await expect(launched.shell.locator('.browser-card')).toHaveCount(1);
  await expect(launched.shell.locator('.stack-switcher')).toContainText('2');
  await expect.poll(async () => (await nativeViews(launched.app)).filter((view) => view.visible).length).toBe(1);

  const stack = (await snapshot(launched.shell)).stacks[0]!;
  await launched.shell.evaluate(({ stackId, browserId }) => window.omniBrowser.workspace.selectStackMember(stackId, browserId), { stackId: stack.id, browserId: ids[0]! });
  await expect.poll(async () => (await snapshot(launched.shell)).stacks[0]?.browserIds.at(-1)).toBe(ids[0]);
  await expect(launched.shell.locator(`[data-browser-id="${ids[0]}"]`)).toBeVisible();
  await expect(launched.shell.locator(`.sidebar-browser-row.is-selected[data-drop-id="${ids[0]}"]`)).toBeVisible();
  await launched.shell.evaluate((stackId) => window.omniBrowser.workspace.unstack(stackId), stack.id);
  await expect.poll(async () => (await snapshot(launched.shell)).stacks).toHaveLength(0);
  await expect(launched.shell.locator('.browser-card')).toHaveCount(2);
  await expect.poll(async () => {
    const unstacked = (await snapshot(launched.shell)).browsers;
    return new Set(unstacked.map((browser) => `${browser.worldRect.x}:${browser.worldRect.y}`)).size;
  }).toBe(2);
  expect(mainProcessNoise(launched.output)).toEqual([]);
  await closeApp(launched);
});

test('sidebar search, pin, drag reorder, locate and hover close stay synchronized with the canvas', async () => {
  const launched = await launchApp(newUserData(seededWorkspace([
    { x: 40, y: 40, url: `${origin}/one` },
    { x: 5000, y: 4000, url: `${origin}/two` }
  ], { selectedIndex: 0 })));
  const initial = await snapshot(launched.shell);
  const [first, second] = initial.browsers;
  const normalRow = (id: string) => launched.shell.locator(`.profile-tree-section .sidebar-browser-row[data-drop-id="${id}"]`);
  await expect(normalRow(first!.id)).toBeVisible();
  await expect(normalRow(second!.id)).toBeVisible();

  const firstBox = (await normalRow(first!.id).boundingBox())!;
  const secondBox = (await normalRow(second!.id).boundingBox())!;
  await launched.shell.mouse.move(secondBox.x + 40, secondBox.y + secondBox.height / 2);
  await launched.shell.mouse.down();
  await launched.shell.mouse.move(firstBox.x + 40, firstBox.y + firstBox.height / 2, { steps: 5 });
  await launched.shell.mouse.up();
  await expect.poll(async () => (await snapshot(launched.shell)).browserOrder).toEqual([second!.id, first!.id]);

  await normalRow(first!.id).hover();
  await normalRow(first!.id).getByRole('button', { name: 'Fijar', exact: true }).click();
  await expect.poll(async () => (await snapshot(launched.shell)).browsers.find((browser) => browser.id === first!.id)?.pin.sidebar).toBe(true);
  await expect(launched.shell.locator('.pinned-section .sidebar-browser-row')).toHaveCount(1);

  const search = launched.shell.getByRole('textbox', { name: 'Buscar navegadores abiertos' });
  await search.fill('two');
  await expect(launched.shell.locator('.profile-tree .sidebar-browser-row')).toHaveCount(1);
  await search.fill('');

  const cameraBefore = (await snapshot(launched.shell)).camera;
  await launched.shell.waitForTimeout(300);
  await normalRow(second!.id).click();
  await expect.poll(async () => (await snapshot(launched.shell)).selectedBrowserId).toBe(second!.id);
  await expect.poll(async () => (await snapshot(launched.shell)).camera.panX).not.toBe(cameraBefore.panX);
  const located = (await launched.shell.locator(`[data-browser-id="${second!.id}"]`).boundingBox())!;
  const canvas = (await launched.shell.locator('.canvas-viewport').boundingBox())!;
  expect(located.x).toBeGreaterThanOrEqual(canvas.x);
  expect(located.x + located.width).toBeLessThanOrEqual(canvas.x + canvas.width);

  await normalRow(second!.id).hover();
  await normalRow(second!.id).locator('.sidebar-close-button').click();
  await expect.poll(async () => (await snapshot(launched.shell)).browsers.map((browser) => browser.id)).not.toContain(second!.id);
  await expect(normalRow(second!.id)).toHaveCount(0);
  expect(mainProcessNoise(launched.output)).toEqual([]);
  await closeApp(launched);
});

test('shift-click multi-select moves and locks the selected group atomically', async () => {
  const launched = await launchApp(newUserData(seededWorkspace([
    { x: 40, y: 40, url: `${origin}/one` },
    { x: 600, y: 40, url: `${origin}/two` }
  ], { selectedIndex: 1 })));
  const initial = await snapshot(launched.shell);
  const [first, second] = initial.browsers;
  await expect(launched.shell.locator(`[data-browser-id="${first!.id}"] .inactive-domain`)).toBeVisible();
  await expect(launched.shell.locator(`[data-browser-id="${first!.id}"] input[aria-label="URL"]`)).toHaveCount(0);
  await expect(launched.shell.locator(`[data-browser-id="${second!.id}"] input[aria-label="URL"]`)).toBeVisible();
  await launched.shell.locator(`[data-browser-id="${first!.id}"] .browser-card-header`).click({ modifiers: ['Shift'] });
  await expect(launched.shell.locator('.selection-toolbar')).toContainText('2 seleccionados');
  const before = new Map((await snapshot(launched.shell)).browsers.map((browser) => [browser.id, browser.worldRect]));
  const header = (await launched.shell.locator(`[data-browser-id="${first!.id}"] .browser-card-header`).boundingBox())!;
  await dispatchDrag(launched.shell, `[data-browser-id="${first!.id}"] .browser-card-header`, { x: header.x + 120, y: header.y + 18 }, { x: 48, y: 36 });
  await expect.poll(async () => (await snapshot(launched.shell)).browsers.find((browser) => browser.id === first!.id)?.worldRect.x).toBeGreaterThan(before.get(first!.id)!.x + 20);
  const moved = new Map((await snapshot(launched.shell)).browsers.map((browser) => [browser.id, browser.worldRect]));
  expect(moved.get(first!.id)!.x - before.get(first!.id)!.x).toBeCloseTo(moved.get(second!.id)!.x - before.get(second!.id)!.x, 4);
  expect(moved.get(first!.id)!.y - before.get(first!.id)!.y).toBeCloseTo(moved.get(second!.id)!.y - before.get(second!.id)!.y, 4);

  await launched.shell.locator('.selection-toolbar').getByRole('button', { name: 'Posición' }).click();
  await expect.poll(async () => (await snapshot(launched.shell)).browsers.every((browser) => browser.positionLocked)).toBe(true);
  const lockedBefore = new Map((await snapshot(launched.shell)).browsers.map((browser) => [browser.id, browser.worldRect]));
  const lockedHeader = (await launched.shell.locator(`[data-browser-id="${first!.id}"] .browser-card-header`).boundingBox())!;
  await dispatchDrag(launched.shell, `[data-browser-id="${first!.id}"] .browser-card-header`, { x: lockedHeader.x + 100, y: lockedHeader.y + 18 }, { x: 80, y: 50 });
  const lockedAfter = new Map((await snapshot(launched.shell)).browsers.map((browser) => [browser.id, browser.worldRect]));
  expect(lockedAfter).toEqual(lockedBefore);
  await launched.shell.locator('.selection-toolbar').getByRole('button', { name: 'Posición' }).click();
  await expect.poll(async () => (await snapshot(launched.shell)).browsers.every((browser) => !browser.positionLocked)).toBe(true);
  await launched.shell.locator('.canvas-viewport').click({ position: { x: 500, y: 700 } });
  await expect.poll(async () => (await snapshot(launched.shell)).selectedBrowserId).toBeNull();
  await expect(launched.shell.locator('.browser-card.is-active')).toHaveCount(0);
  expect(mainProcessNoise(launched.output)).toEqual([]);
  await closeApp(launched);
});

test('private navigation failures never place a domain, URL or title in shell error notices', async () => {
  const launched = await launchApp(newUserData());
  await launched.shell.getByRole('button', { name: 'Perfil', exact: true }).click();
  await launched.shell.getByPlaceholder('Nombre').fill('Ephemeral QA');
  await launched.shell.getByRole('button', { name: 'Private', exact: true }).click();
  await launched.shell.getByRole('button', { name: 'Crear perfil' }).click();
  await launched.shell.getByRole('button', { name: 'Abrir navegador' }).click();
  const afterCreate = await snapshot(launched.shell);
  const privateProfile = afterCreate.profiles.find((profile) => profile.name === 'Ephemeral QA');
  const privateBrowser = afterCreate.browsers.find((browser) => browser.profileId === privateProfile?.id);
  expect(privateBrowser).toBeDefined();

  await submitUrl(launched.shell, 'http://127.0.0.1:1/private-secret-token');
  const notice = launched.shell.locator('.notice-toast');
  await expect(notice).toContainText('No se pudo cargar una página en un browser Private.');
  await expect(notice).not.toContainText('127.0.0.1');
  await expect(notice).not.toContainText('private-secret-token');
  expect(mainProcessNoise(launched.output)).toEqual([]);
  await closeApp(launched);
});

test('a failed profile creation keeps the panel open with the typed name', async () => {
  const launched = await launchApp(newUserData());
  await launched.shell.getByRole('button', { name: 'Perfil', exact: true }).click();
  await launched.shell.getByPlaceholder('Nombre').fill('personal');
  await launched.shell.getByRole('button', { name: 'Crear perfil' }).click();
  await expect(launched.shell.locator('.notice-toast')).toContainText('Ya existe un perfil llamado');
  await expect(launched.shell.getByPlaceholder('Nombre')).toHaveValue('personal');
  expect((await snapshot(launched.shell)).profiles.filter((profile) => profile.name.toLowerCase() === 'personal')).toHaveLength(1);
  await closeApp(launched);
});
