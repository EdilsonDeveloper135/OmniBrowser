import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import electronExecutable from 'electron';

const repositoryRoot = process.cwd();
// Committed visual evidence is only replaced on explicit request, after reviewing the new captures.
const visualArtifactDirectory = process.env.OMNIBROWSER_UPDATE_VISUAL_EVIDENCE === '1'
  ? path.join(repositoryRoot, 'docs', 'design')
  : path.join(repositoryRoot, 'test-results', 'visual');
const visualArchitecture = process.arch;
const sharedToken = `e2e-${Date.now()}`;

let fixtureServer: Server;
let fixtureOrigin: string;
let userDataDirectory: string;
let electronApp: ElectronApplication;
let shell: Page;
let reloadRequestCount = 0;

function fixtureHtml(title: string, script = ''): string {
  return `<!doctype html>
  <html lang="es">
    <head>
      <meta charset="utf-8">
      <title>${title}</title>
      <style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#f3f6fa;color:#17202a;font:600 24px system-ui}</style>
    </head>
    <body>${title}<script>${script}</script></body>
  </html>`;
}

async function launchApp(expectedBrowserCount = 1): Promise<void> {
  electronApp = await electron.launch({
    executablePath: electronExecutable as unknown as string,
    args: [path.join('.webpack', process.arch, 'main', 'index.js')],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      OMNIBROWSER_E2E: '1',
      OMNIBROWSER_E2E_USER_DATA: userDataDirectory
    },
    timeout: 30_000
  });
  await electronApp.firstWindow();
  await expect.poll(
    () => electronApp.windows().map((candidate) => candidate.url()),
    { message: 'the React shell should load through the custom protocol', timeout: 15_000 }
  ).toContain('omnibrowser://app/index.html');
  const shellCandidate = electronApp.windows().find((candidate) => candidate.url() === 'omnibrowser://app/index.html');
  if (!shellCandidate) throw new Error('The OmniBrowser shell page was not exposed to Playwright.');
  shell = shellCandidate;
  await shell.waitForLoadState('domcontentloaded');
  await expect(shell.getByText('OmniBrowser', { exact: true })).toBeVisible();
  await expect(shell.locator('.browser-card')).toHaveCount(expectedBrowserCount);
}

async function closeApp(): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.close();
  });
  await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), { timeout: 15_000 }).toBe(0);
  await electronApp.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
  await electronApp.close().catch(() => undefined);
}

async function snapshot() {
  return shell.evaluate(() => window.omniBrowser.bootstrap());
}

async function selectBrowser(browserId: string): Promise<void> {
  const minimapTarget = shell.locator(`[data-minimap-browser="${browserId}"]`);
  await minimapTarget.focus();
  await minimapTarget.press('Enter');
  await expect(shell.locator(`[data-browser-id="${browserId}"]`)).toHaveClass(/is-selected/);
  await expect.poll(async () => (await snapshot()).selectedBrowserId).toBe(browserId);
}

async function navigate(url: string): Promise<void> {
  const input = shell.getByRole('textbox', { name: 'URL' });
  await input.fill(url);
  await expect(input).toHaveValue(url);
  await input.evaluate((element) => {
    const form = (element as HTMLInputElement).form;
    if (!form) throw new Error('The URL input is not associated with its navigation form.');
    form.requestSubmit();
  });
  if (url.startsWith('http://') || url.startsWith('https://')) {
    const expectedUrl = new URL(url).toString();
    await expect.poll(async () => {
      const state = await snapshot();
      return state.browsers.find((browser) => browser.id === state.selectedBrowserId)?.url;
    }).toBe(expectedUrl);
  }
}

async function waitForSelectedBrowser(browserId: string): Promise<void> {
  await expect(shell.locator(`[data-browser-id="${browserId}"]`)).toHaveClass(/is-selected/);
  await expect.poll(async () => (await snapshot()).selectedBrowserId).toBe(browserId);
}

async function selectedBrowserTitle(): Promise<string> {
  const state = await snapshot();
  return state.browsers.find((browser) => browser.id === state.selectedBrowserId)?.title ?? '';
}

async function dismissNoticeIfPresent(): Promise<void> {
  const close = shell.getByRole('button', { name: 'Cerrar aviso' });
  if (await close.isVisible()) await close.click();
}

async function dragPointer(
  target: Locator,
  start: { x: number; y: number },
  delta: { x: number; y: number },
  pointerId: number
): Promise<void> {
  const pointer = { pointerId, pointerType: 'mouse', isPrimary: true };
  await target.dispatchEvent('pointerdown', {
    ...pointer,
    button: 0,
    buttons: 1,
    clientX: start.x,
    clientY: start.y
  });
  await shell.locator('body').dispatchEvent('pointermove', {
    ...pointer,
    button: 0,
    buttons: 1,
    clientX: start.x + delta.x,
    clientY: start.y + delta.y
  });
  await shell.locator('body').dispatchEvent('pointerup', {
    ...pointer,
    button: 0,
    buttons: 0,
    clientX: start.x + delta.x,
    clientY: start.y + delta.y
  });
}

test.describe.serial('OmniBrowser production renderer bundle and native-view runtime', () => {
  test.beforeAll(async () => {
    userDataDirectory = mkdtempSync(path.join(tmpdir(), 'omnibrowser-e2e-'));
    fixtureServer = createServer((request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.setHeader('cache-control', 'no-store');
      if (request.url?.startsWith('/set')) {
        response.end(fixtureHtml('SET', `
          document.cookie = 'omni_persistent=${sharedToken}; Path=/; Max-Age=3600; SameSite=Lax';
          document.cookie = 'omni_session=${sharedToken}; Path=/; SameSite=Lax';
          localStorage.setItem('omni-token', '${sharedToken}');
          document.title = 'SET ${sharedToken}';
        `));
        return;
      }
      if (request.url?.startsWith('/read')) {
        response.end(fixtureHtml('READ', `
          const cookies = Object.fromEntries(document.cookie.split('; ').filter(Boolean).map((pair) => pair.split('=')));
          const persistent = cookies.omni_persistent || 'none';
          const session = cookies.omni_session || 'none';
          const storage = localStorage.getItem('omni-token') || 'none';
          document.title = 'READ p:' + persistent + ' s:' + session + ' l:' + storage;
        `));
        return;
      }
      if (request.url?.startsWith('/two')) {
        response.end(fixtureHtml('Fixture two'));
        return;
      }
      if (request.url?.startsWith('/reload')) {
        reloadRequestCount += 1;
        response.end(fixtureHtml(`Reload ${reloadRequestCount}`));
        return;
      }
      response.end(fixtureHtml('Fixture one'));
    });
    await new Promise<void>((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
    const address = fixtureServer.address();
    if (!address || typeof address === 'string') throw new Error('The fixture server did not expose a TCP port.');
    fixtureOrigin = `http://127.0.0.1:${address.port}`;

    await launchApp();
  });

  test.afterAll(async () => {
    if (electronApp) {
      await electronApp.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
      await electronApp.close().catch(() => undefined);
    }
    await new Promise<void>((resolve) => fixtureServer.close(() => resolve()));
    const resolved = path.resolve(userDataDirectory);
    if (resolved.startsWith(`${tmpdir()}${path.sep}omnibrowser-e2e-`)) rmSync(resolved, { recursive: true, force: true });
  });

  test('creates profiles and browsers, shares one profile, and isolates another', async () => {
    const initial = await snapshot();
    const personal = initial.profiles.find((profile) => profile.name === 'Personal');
    expect(personal).toBeTruthy();

    await shell.getByRole('button', { name: 'Perfil', exact: true }).click();
    await shell.getByPlaceholder('Nombre').fill('Trabajo');
    await shell.getByRole('button', { name: 'Crear perfil' }).click();
    await expect(shell.getByRole('button', { name: /Trabajo/ })).toBeVisible();

    await shell.getByRole('button', { name: 'Abrir navegador' }).click();
    await expect(shell.locator('.browser-card')).toHaveCount(2);
    const afterFirstWorkBrowser = await snapshot();
    const work = afterFirstWorkBrowser.profiles.find((profile) => profile.name === 'Trabajo');
    const workBrowserOne = afterFirstWorkBrowser.browsers.find((browser) => browser.profileId === work?.id);
    expect(work).toBeTruthy();
    expect(workBrowserOne).toBeTruthy();

    await waitForSelectedBrowser(workBrowserOne!.id);
    await navigate(`${fixtureOrigin}/set`);
    await expect.poll(selectedBrowserTitle).toBe(`SET ${sharedToken}`);

    await shell.getByRole('button', { name: 'Abrir navegador' }).click();
    await expect(shell.locator('.browser-card')).toHaveCount(3);
    const afterSecondWorkBrowser = await snapshot();
    const workBrowsers = afterSecondWorkBrowser.browsers.filter((browser) => browser.profileId === work?.id);
    expect(workBrowsers).toHaveLength(2);
    const workBrowserTwo = workBrowsers.find((browser) => browser.id !== workBrowserOne?.id);
    expect(workBrowserTwo).toBeTruthy();

    await waitForSelectedBrowser(workBrowserTwo!.id);
    await navigate(`${fixtureOrigin}/read`);
    await expect.poll(selectedBrowserTitle).toBe(`READ p:${sharedToken} s:${sharedToken} l:${sharedToken}`);

    const personalBrowser = afterSecondWorkBrowser.browsers.find((browser) => browser.profileId === personal?.id);
    expect(personalBrowser).toBeTruthy();
    await selectBrowser(personalBrowser!.id);
    await waitForSelectedBrowser(personalBrowser!.id);
    await navigate(`${fixtureOrigin}/read`);
    await expect.poll(selectedBrowserTitle).toBe('READ p:none s:none l:none');
    await expect(shell.getByText(/No se pudo restaurar todo el historial/)).toHaveCount(0);

    await electronApp.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    await shell.locator(`[data-browser-id="${personalBrowser!.id}"] select`).selectOption(work!.id);
    await expect.poll(async () => (await snapshot()).browsers.find((browser) => browser.id === personalBrowser!.id)?.profileId).toBe(work!.id);
    await navigate(`${fixtureOrigin}/read`);
    await expect.poll(selectedBrowserTitle).toBe(`READ p:${sharedToken} s:${sharedToken} l:${sharedToken}`);

    await shell.locator(`[data-browser-id="${personalBrowser!.id}"] select`).selectOption(personal!.id);
    await expect.poll(async () => (await snapshot()).browsers.find((browser) => browser.id === personalBrowser!.id)?.profileId).toBe(personal!.id);
    await navigate(`${fixtureOrigin}/read`);
    await expect.poll(selectedBrowserTitle).toBe('READ p:none s:none l:none');
  });

  test('navigates, reloads, sleeps, wakes, moves, resizes, pans, and changes zoom modes', async () => {
    const current = await snapshot();
    const work = current.profiles.find((profile) => profile.name === 'Trabajo');
    const workBrowser = current.browsers.find((browser) => browser.profileId === work?.id);
    expect(workBrowser).toBeTruthy();
    await selectBrowser(workBrowser!.id);

    await navigate(`${fixtureOrigin}/one`);
    await expect.poll(selectedBrowserTitle).toBe('Fixture one');
    await navigate(`${fixtureOrigin}/two`);
    await expect.poll(selectedBrowserTitle).toBe('Fixture two');
    await shell.getByRole('button', { name: 'Atrás' }).click();
    await expect.poll(selectedBrowserTitle).toBe('Fixture one');
    await shell.getByRole('button', { name: 'Adelante' }).click();
    await expect.poll(selectedBrowserTitle).toBe('Fixture two');

    await navigate(`${fixtureOrigin}/reload`);
    await expect.poll(selectedBrowserTitle).toBe('Reload 1');
    await shell.getByRole('button', { name: 'Recargar' }).click();
    await expect.poll(() => reloadRequestCount).toBeGreaterThanOrEqual(2);

    const selectedCard = shell.locator(`[data-browser-id="${workBrowser!.id}"]`);
    await selectedCard.getByRole('button', { name: 'Suspender' }).click();
    await expect(selectedCard.getByText('Navegador en reposo')).toBeVisible();
    await selectedCard.getByRole('button', { name: 'Reactivar' }).click();
    await expect.poll(async () => (await snapshot()).browsers.find((browser) => browser.id === workBrowser!.id)?.runtime.isAwake).toBe(true);
    await expect(shell.getByText(/No se pudo restaurar todo el historial/)).toHaveCount(0);

    const beforeMove = (await snapshot()).browsers.find((browser) => browser.id === workBrowser!.id)!.worldRect;
    const browserHeader = selectedCard.locator('.browser-card-header');
    const headerBox = await browserHeader.boundingBox();
    if (!headerBox) throw new Error('Browser header has no layout box.');
    await dragPointer(browserHeader, { x: headerBox.x + 150, y: headerBox.y + 18 }, { x: 60, y: 40 }, 5);
    await expect.poll(async () => (await snapshot()).browsers.find((browser) => browser.id === workBrowser!.id)?.worldRect.x).toBeGreaterThan(beforeMove.x + 20);

    const beforeResize = (await snapshot()).browsers.find((browser) => browser.id === workBrowser!.id)!.worldRect;
    const resizeHandle = selectedCard.locator('.resize-se');
    const resizeBox = await resizeHandle.boundingBox();
    if (!resizeBox) throw new Error('Resize handle has no layout box.');
    const resizeStart = { x: resizeBox.x + resizeBox.width / 2, y: resizeBox.y + resizeBox.height / 2 };
    await dragPointer(resizeHandle, resizeStart, { x: 60, y: 45 }, 7);
    await expect.poll(async () => (await snapshot()).browsers.find((browser) => browser.id === workBrowser!.id)?.worldRect.width).toBeGreaterThan(beforeResize.width + 20);

    const cameraBeforePan = (await snapshot()).camera;
    const canvas = shell.locator('.canvas-viewport');
    const canvasBox = await canvas.boundingBox();
    if (!canvasBox) throw new Error('Canvas has no layout box.');
    await dragPointer(canvas, {
      x: canvasBox.x + canvasBox.width / 2,
      y: canvasBox.y + canvasBox.height / 2
    }, { x: -50, y: -40 }, 9);
    await expect.poll(async () => (await snapshot()).camera.panX).not.toBe(cameraBeforePan.panX);

    for (let index = 0; index < 4; index += 1) await shell.getByRole('button', { name: 'Alejar' }).click();
    await expect(shell.locator('.semantic-card')).toHaveCount(3);
    await shell.screenshot({ path: path.join(visualArtifactDirectory, `implementation-semantic-zoom-${visualArchitecture}.png`) });
    await shell.locator('.semantic-card.is-selected').click();
    await expect(shell.locator('.browser-card')).toHaveCount(3);
    await expect.poll(async () => (await snapshot()).camera.zoom).toBe(0.72);
  });

  test('blocks unsafe URLs, persists durable state, and excludes temporary state after restart', async () => {
    await navigate('javascript:alert(1)');
    await expect(shell.locator('.notice-toast')).toContainText('no está permitido');
    await expect(shell.locator('.notice-toast')).not.toContainText('Error invoking remote method');
    await dismissNoticeIfPresent();

    await shell.getByRole('button', { name: 'Perfil', exact: true }).click();
    await shell.getByPlaceholder('Nombre').fill('Descartable');
    await shell.getByRole('button', { name: 'Temporal', exact: true }).click();
    await shell.getByRole('button', { name: 'Crear perfil' }).click();
    await shell.getByRole('button', { name: 'Abrir navegador' }).click();
    const beforeRestart = await snapshot();
    const temporary = beforeRestart.profiles.find((profile) => profile.name === 'Descartable');
    const temporaryBrowser = beforeRestart.browsers.find((browser) => browser.profileId === temporary?.id);
    const persistentProfileIds = new Set(beforeRestart.profiles.filter((profile) => profile.kind === 'persistent').map((profile) => profile.id));
    const expectedPersistentBrowserCount = beforeRestart.browsers.filter((browser) => persistentProfileIds.has(browser.profileId)).length;
    expect(temporary?.kind).toBe('temporary');
    expect(temporaryBrowser).toBeTruthy();
    await expect(shell.locator('.browser-card')).toHaveCount(beforeRestart.browsers.length);

    await shell.evaluate(() => window.omniBrowser.workspace.saveNow());
    await shell.screenshot({ path: path.join(visualArtifactDirectory, `implementation-primary-${visualArchitecture}.png`) });
    await closeApp();
    await launchApp(expectedPersistentBrowserCount);

    const restored = await snapshot();
    expect(restored.profiles.some((profile) => profile.name === 'Trabajo' && profile.kind === 'persistent')).toBe(true);
    expect(restored.profiles.some((profile) => profile.name === 'Descartable')).toBe(false);
    expect(restored.browsers.some((browser) => browser.id === temporaryBrowser!.id)).toBe(false);

    const restoredWork = restored.profiles.find((profile) => profile.name === 'Trabajo');
    const restoredWorkBrowser = restored.browsers.find((browser) => browser.profileId === restoredWork?.id);
    expect(restoredWorkBrowser).toBeTruthy();
    await selectBrowser(restoredWorkBrowser!.id);
    await navigate(`${fixtureOrigin}/read`);
    await expect.poll(selectedBrowserTitle).toBe(`READ p:${sharedToken} s:none l:${sharedToken}`);
    await dismissNoticeIfPresent();

    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1040, 680, false);
    });
    const fit = await shell.evaluate(() => {
      const selectors = ['.profile-rail', '.top-toolbar', '.canvas-viewport', '.status-bar'];
      return {
        viewport: { width: innerWidth, height: innerHeight },
        scroll: {
          x: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          y: document.documentElement.scrollHeight > document.documentElement.clientHeight
        },
        regions: selectors.map((selector) => {
          const rect = document.querySelector(selector)?.getBoundingClientRect();
          return { selector, rect: rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null };
        })
      };
    });
    expect(fit.viewport).toEqual({ width: 1040, height: 680 });
    expect(fit.scroll).toEqual({ x: false, y: false });
    for (const region of fit.regions) {
      expect(region.rect, `${region.selector} should exist`).not.toBeNull();
      expect(region.rect!.left).toBeGreaterThanOrEqual(0);
      expect(region.rect!.top).toBeGreaterThanOrEqual(0);
      expect(region.rect!.right).toBeLessThanOrEqual(fit.viewport.width);
      expect(region.rect!.bottom).toBeLessThanOrEqual(fit.viewport.height);
    }
    await shell.screenshot({ path: path.join(visualArtifactDirectory, `implementation-minimum-window-${visualArchitecture}.png`) });
  });
});
