const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, WebContentsView, session } = require('electron');

function argument(name) {
  const prefix = `--${name}=`;
  const value = process.argv.find((entry) => entry.startsWith(prefix));
  if (!value) throw new Error(`Missing required ${prefix}<value> argument.`);
  return value.slice(prefix.length);
}

const output = argument('output');
const origin = argument('origin');
const userData = argument('user-data');
app.setPath('userData', userData);

const secureWebPreferences = (profileSession, inherited = {}) => ({
  ...inherited,
  session: profileSession,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  webviewTag: false,
  backgroundThrottling: true,
  enableWebSQL: false
});

const waitFor = async (predicate, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out after ${timeoutMs}ms.`);
};

app.whenReady().then(async () => {
  const profileSession = session.fromPartition('persist:omnibrowser-profile-popup-poc');
  const window = new BrowserWindow({
    show: false,
    width: 1100,
    height: 720,
    useContentSize: true,
    webPreferences: secureWebPreferences(session.defaultSession)
  });
  const parentView = new WebContentsView({ webPreferences: secureWebPreferences(profileSession) });
  const childViews = new Set();
  const openedUrls = [];
  const loadedUrls = [];
  const childSessionMatches = [];
  window.contentView.addChildView(parentView);
  parentView.setBounds({ x: 0, y: 0, width: 600, height: 700 });

  try {
    await parentView.webContents.loadURL(`${origin}/popup-parent.html`);
    parentView.webContents.setWindowOpenHandler(({ url }) => {
      let parsed;
      try { parsed = new URL(url); } catch { return { action: 'deny' }; }
      if (parsed.origin !== origin || !['/popup-child.html', '/popup-target.html'].includes(parsed.pathname)) return { action: 'deny' };
      openedUrls.push(parsed.pathname);
      return {
        action: 'allow',
        outlivesOpener: false,
        overrideBrowserWindowOptions: {
          show: false,
          webPreferences: secureWebPreferences(profileSession)
        },
        createWindow: (options) => {
          const providedContents = options.webContents;
          if (!providedContents) throw new Error('Electron did not provide the popup WebContents for a foreground popup.');
          const childView = new WebContentsView({ webContents: providedContents });
          const childContents = childView.webContents;
          childViews.add(childView);
          childSessionMatches.push(childContents.session === profileSession);
          childView.setBounds({ x: 620, y: 80, width: 460, height: 360 });
          window.contentView.addChildView(childView);
          childContents.once('did-finish-load', () => loadedUrls.push(childContents.getURL()));
          childContents.once('destroyed', () => {
            try { window.contentView.removeChildView(childView); } catch {}
            childViews.delete(childView);
          });
          return childContents;
        }
      };
    });

    window.showInactive();
    const opened = await parentView.webContents.executeJavaScript("window.__popupPoc.start('popup-profile-token')", true);
    if (!opened) throw new Error('window.open returned null.');
    const firstFlow = await waitFor(async () => {
      const state = await parentView.webContents.executeJavaScript('window.__popupPoc.state()', true);
      return state.ready && state.pong && state.closed ? state : null;
    });
    await waitFor(() => Promise.resolve(childViews.size === 0));

    await parentView.webContents.executeJavaScript('window.__popupPoc.openTarget()', true);
    await waitFor(() => Promise.resolve(loadedUrls.some((url) => url === `${origin}/popup-target.html`)));
    await waitFor(() => Promise.resolve(childViews.size === 0));

    const assertions = {
      windowOpenCreatedCard: openedUrls.includes('/popup-child.html'),
      targetBlankCreatedCard: openedUrls.includes('/popup-target.html'),
      sameSessionObject: childSessionMatches.length === 2 && childSessionMatches.every(Boolean),
      childReadSharedCookie: typeof firstFlow.cookie === 'string' && firstFlow.cookie.includes('popupShared=popup-profile-token'),
      childReachedOpener: firstFlow.ready === true,
      bidirectionalPostMessage: firstFlow.pong === true,
      windowCloseDestroyedCard: firstFlow.closed === true && childViews.size === 0,
      targetBlankNavigatedAndClosed: loadedUrls.includes(`${origin}/popup-target.html`) && childViews.size === 0
    };
    const report = {
      poc: 'popup-and-auth-flow',
      passed: Object.values(assertions).every(Boolean),
      electron: process.versions.electron,
      platform: process.platform,
      architecture: process.arch,
      openedUrls,
      loadedUrls,
      assertions
    };
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
    window.contentView.removeChildView(parentView);
    if (!parentView.webContents.isDestroyed()) parentView.webContents.close({ waitForBeforeUnload: false });
    window.destroy();
    app.exit(report.passed ? 0 : 1);
  } catch (error) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify({ poc: 'popup-and-auth-flow', passed: false, openedUrls, error: error instanceof Error ? error.stack : String(error) }, null, 2));
    for (const childView of childViews) {
      try {
        const contents = childView.webContents;
        if (contents && !contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
      } catch {}
    }
    try {
      const parentContents = parentView.webContents;
      if (parentContents && !parentContents.isDestroyed()) parentContents.close({ waitForBeforeUnload: false });
    } catch {}
    if (!window.isDestroyed()) window.destroy();
    app.exit(1);
  }
});
