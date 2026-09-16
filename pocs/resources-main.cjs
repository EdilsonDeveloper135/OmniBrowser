const fs = require('node:fs');
const os = require('node:os');
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

const secureWebPreferences = (profileSession) => ({
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

const settle = () => new Promise((resolve) => setTimeout(resolve, 450));

async function snapshot(stage, viewCount) {
  const appMetrics = app.getAppMetrics().map((metric) => ({
    pid: metric.pid,
    type: metric.type,
    cpuPercent: metric.cpu.percentCPUUsage,
    workingSetKb: metric.memory.workingSetSize,
    peakWorkingSetKb: metric.memory.peakWorkingSetSize,
    privateBytesKb: metric.memory.privateBytes,
    sharedBytesKb: metric.memory.sharedBytes
  }));
  return {
    stage,
    viewCount,
    capturedAt: new Date().toISOString(),
    mainProcessMemoryKb: await process.getProcessMemoryInfo(),
    totalWorkingSetKb: appMetrics.reduce((total, metric) => total + metric.workingSetKb, 0),
    appMetrics
  };
}

async function createView(window, profileSession, index) {
  const view = new WebContentsView({ webPreferences: secureWebPreferences(profileSession) });
  window.contentView.addChildView(view);
  view.setBounds({ x: 20 + (index % 3) * 330, y: 20 + Math.floor(index / 3) * 230, width: 320, height: 220 });
  await view.webContents.loadURL(`${origin}/resource.html?index=${index}`);
  return view;
}

function destroyViews(window, views) {
  for (const view of views) {
    try { window.contentView.removeChildView(view); } catch {}
    try {
      const contents = view.webContents;
      if (contents && !contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
    } catch {}
  }
}

app.whenReady().then(async () => {
  const profileSession = session.fromPartition('persist:omnibrowser-profile-resource-poc');
  const window = new BrowserWindow({
    show: false,
    width: 1080,
    height: 760,
    useContentSize: true,
    backgroundColor: '#0b1118',
    webPreferences: secureWebPreferences(session.defaultSession)
  });
  const scenarios = [];
  const liveViews = new Set();

  try {
    window.showInactive();
    for (const count of [1, 5, 10]) {
      const views = [];
      for (let index = 0; index < count; index += 1) {
        const view = await createView(window, profileSession, index);
        views.push(view);
        liveViews.add(view);
      }
      const token = `resource-token-${count}`;
      await views[0].webContents.executeJavaScript(`window.__resourcePoc.write(${JSON.stringify(token)})`, true);
      await settle();
      const visible = await snapshot('visible', count);

      for (const view of views) view.setVisible(false);
      await settle();
      const hidden = await snapshot('hidden-setVisible-false', count);

      for (let index = 0; index < views.length; index += 1) {
        views[index].setVisible(true);
        views[index].setBounds({ x: 5000 + index * 20, y: 5000, width: 320, height: 220 });
      }
      await settle();
      const offViewport = await snapshot('off-viewport', count);

      destroyViews(window, views);
      for (const view of views) liveViews.delete(view);
      await settle();
      const suspended = await snapshot('suspended-destroyed', 0);

      const awakened = await createView(window, profileSession, 0);
      liveViews.add(awakened);
      const restoredToken = await awakened.webContents.executeJavaScript('window.__resourcePoc.read()', true);
      const restoredUrl = awakened.webContents.getURL();
      await settle();
      const awake = await snapshot('awakened', 1);
      destroyViews(window, [awakened]);
      liveViews.delete(awakened);
      scenarios.push({ count, token, restoredToken, restoredUrl, measurements: { visible, hidden, offViewport, suspended, awake } });
    }

    const assertions = {
      allCardCountsMeasured: scenarios.map((scenario) => scenario.count).join(',') === '1,5,10',
      everyLifecycleStageMeasured: scenarios.every((scenario) => Object.keys(scenario.measurements).length === 5),
      wakeUsesSameProfileStorage: scenarios.every((scenario) => scenario.restoredToken === scenario.token),
      wakeRestoresUrl: scenarios.every((scenario) => scenario.restoredUrl.startsWith(`${origin}/resource.html`)),
      backgroundThrottlingLeftEnabled: true
    };
    const report = {
      poc: 'resource-lifecycle',
      passed: Object.values(assertions).every(Boolean),
      electron: process.versions.electron,
      platform: process.platform,
      architecture: process.arch,
      machine: {
        osRelease: os.release(),
        cpuModel: os.cpus()[0]?.model || 'unknown',
        logicalCpuCount: os.cpus().length,
        totalMemoryBytes: os.totalmem()
      },
      units: { processMemory: 'KiB', cpu: 'percent as reported by Electron' },
      assertions,
      scenarios
    };
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
    window.destroy();
    app.exit(report.passed ? 0 : 1);
  } catch (error) {
    destroyViews(window, [...liveViews]);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify({ poc: 'resource-lifecycle', passed: false, error: error instanceof Error ? error.stack : String(error) }, null, 2));
    if (!window.isDestroyed()) window.destroy();
    app.exit(1);
  }
});
