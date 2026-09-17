const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, WebContentsView, session } = require('electron');

function argument(name) {
  const prefix = `--${name}=`;
  const value = process.argv.find((entry) => entry.startsWith(prefix));
  if (!value) throw new Error(`Missing required ${prefix}<value> argument.`);
  return value.slice(prefix.length);
}

const phase = argument('phase');
const origin = argument('origin');
const output = argument('output');
const userData = argument('user-data');
app.setPath('userData', userData);

const secureWebPreferences = (profileSession) => ({
  session: profileSession,
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  webviewTag: false,
  backgroundThrottling: true
});

async function createView(window, profileSession, x) {
  const view = new WebContentsView({ webPreferences: secureWebPreferences(profileSession) });
  window.contentView.addChildView(view);
  view.setBounds({ x, y: 0, width: 320, height: 240 });
  await view.webContents.loadURL(`${origin}/storage.html`);
  return view;
}

async function execute(view, source) {
  return view.webContents.executeJavaScript(source, true);
}

async function closeAll(window, views) {
  for (const view of views) {
    try { window.contentView.removeChildView(view); } catch {}
    try {
      const contents = view.webContents;
      if (contents && !contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
    } catch {}
  }
  if (!window.isDestroyed()) window.destroy();
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: secureWebPreferences(session.defaultSession) });
  const shared = session.fromPartition('persist:omnibrowser-profile-poc-shared');
  const isolated = session.fromPartition('persist:omnibrowser-profile-poc-isolated');
  const privateSession = session.fromPartition('omnibrowser-private-poc');
  const views = [];

  try {
    const sharedA = await createView(window, shared, 0); views.push(sharedA);
    const sharedB = await createView(window, shared, 330); views.push(sharedB);
    const isolatedC = await createView(window, isolated, 660); views.push(isolatedC);
    const privateA = await createView(window, privateSession, 0); views.push(privateA);
    const privateB = await createView(window, privateSession, 330); views.push(privateB);

    let result;
    if (phase === 'seed') {
      const sharedToken = 'shared-profile-token';
      const privateToken = 'private-profile-token';
      const sharedWrite = await execute(sharedA, `window.__storagePoc.write(${JSON.stringify(sharedToken)}, '/http-cache/shared')`);
      const sharedRead = await execute(sharedB, 'window.__storagePoc.read()');
      const sharedHttpCacheBody = await execute(sharedB, "window.__storagePoc.fetchHttpCache('/http-cache/shared')");
      const isolatedRead = await execute(isolatedC, 'window.__storagePoc.read()');
      const isolatedHttpCacheBody = await execute(isolatedC, "window.__storagePoc.fetchHttpCache('/http-cache/shared')");
      const privateWrite = await execute(privateA, `window.__storagePoc.write(${JSON.stringify(privateToken)}, '/http-cache/private')`);
      const privateRead = await execute(privateB, 'window.__storagePoc.read()');
      const privateHttpCacheBody = await execute(privateB, "window.__storagePoc.fetchHttpCache('/http-cache/private')");
      const reassignedBefore = await createView(window, shared, 660); views.push(reassignedBefore);
      const reassignedBeforeRead = await execute(reassignedBefore, 'window.__storagePoc.read()');
      window.contentView.removeChildView(reassignedBefore);
      reassignedBefore.webContents.close({ waitForBeforeUnload: false });
      const reassignedAfter = await createView(window, isolated, 660); views.push(reassignedAfter);
      const reassignedAfterRead = await execute(reassignedAfter, 'window.__storagePoc.read()');
      const originalProfileAfterReassign = await execute(sharedB, 'window.__storagePoc.read()');
      await shared.flushStorageData();
      await shared.cookies.flushStore();
      await isolated.flushStorageData();
      await isolated.cookies.flushStore();
      result = {
        phase,
        sharedWrite,
        sharedRead,
        sharedHttpCacheBody,
        isolatedRead,
        isolatedHttpCacheBody,
        privateWrite,
        privateRead,
        privateHttpCacheBody,
        reassignedBeforeRead,
        reassignedAfterRead,
        originalProfileAfterReassign,
        storagePaths: {
          shared: shared.storagePath,
          isolated: isolated.storagePath,
          private: privateSession.storagePath
        }
      };
    } else if (phase === 'verify') {
      result = {
        phase,
        sharedReadA: await execute(sharedA, 'window.__storagePoc.read()'),
        sharedReadB: await execute(sharedB, 'window.__storagePoc.read()'),
        sharedHttpCacheBody: await execute(sharedA, "window.__storagePoc.fetchHttpCache('/http-cache/shared')"),
        isolatedRead: await execute(isolatedC, 'window.__storagePoc.read()'),
        privateReadA: await execute(privateA, 'window.__storagePoc.read()'),
        privateReadB: await execute(privateB, 'window.__storagePoc.read()'),
        privateHttpCacheBody: await execute(privateA, "window.__storagePoc.fetchHttpCache('/http-cache/private')")
      };
    } else {
      throw new Error(`Unknown storage POC phase: ${phase}`);
    }

    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(result, null, 2));
    await closeAll(window, views);
    app.exit(0);
  } catch (error) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify({ phase, error: error instanceof Error ? error.stack : String(error) }, null, 2));
    await closeAll(window, views);
    app.exit(1);
  }
});
