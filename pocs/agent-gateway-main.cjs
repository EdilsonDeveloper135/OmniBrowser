// Scoped-CDP compatibility trace: the pinned Browser Use release drives one card through the production
// ScopedCdpGateway while a second card must stay unreachable. Run with `npm run agent:compat`.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { app, BrowserWindow, WebContentsView, session } = require('electron');
const { createTypeScriptLoader } = require('./lib/load-typescript.cjs');

function argument(name) {
  const prefix = `--${name}=`;
  const value = process.argv.find((entry) => entry.startsWith(prefix));
  if (!value) throw new Error(`Missing required ${prefix}<value> argument.`);
  return value.slice(prefix.length);
}

const output = argument('output');
const userData = argument('user-data');
const python = argument('python');
const root = path.resolve(__dirname, '..');
app.setPath('userData', userData);

const pages = {
  '/card-a': `<!doctype html><title>Card A</title><body>
    <button id="continue" onclick="document.title = 'Clicked'">Continue</button>
    <input id="field" placeholder="Name">
    <script>window.visibilityChanges = []; document.addEventListener('visibilitychange', () => visibilityChanges.push(document.visibilityState));</script>
  </body>`,
  '/card-a-next': '<!doctype html><title>Next</title><body><p>Second page of card A</p></body>',
  '/card-b': '<!doctype html><title>Card B</title><body><p>Private neighbour card</p></body>'
};

const cardPreferences = (partition) => ({
  session: session.fromPartition(partition),
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  webviewTag: false,
  backgroundThrottling: true,
  devTools: false
});

app.whenReady().then(async () => {
  const report = { passed: false };
  const server = http.createServer((request, response) => {
    const body = pages[request.url ?? ''];
    response.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    response.end(body ?? 'Not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const gateways = [];
  let child = null;
  try {
    const loader = createTypeScriptLoader(root);
    const { ScopedCdpGateway } = loader.load('src/main/agents/scoped-cdp-gateway.ts');
    const { isSyntheticInputInFlight } = loader.load('src/main/browser/automation-input.ts');

    const window = new BrowserWindow({ show: true, width: 1200, height: 760, useContentSize: true });
    const viewA = new WebContentsView({ webPreferences: cardPreferences('persist:omnibrowser-agent-poc-a') });
    const viewB = new WebContentsView({ webPreferences: cardPreferences('persist:omnibrowser-agent-poc-b') });
    for (const [view, x] of [[viewA, 20], [viewB, 620]]) {
      window.contentView.addChildView(view);
      view.setBounds({ x, y: 20, width: 560, height: 700 });
      view.setVisible(true);
    }
    await Promise.all([viewA.webContents.loadURL(`${origin}/card-a`), viewB.webContents.loadURL(`${origin}/card-b`)]);

    const targetFor = (view) => ({
      browserId: randomUUID(),
      profileId: randomUUID(),
      contents: view.webContents,
      contentsId: view.webContents.id,
      targetId: view.webContents.getOrCreateDevToolsTargetId(),
      runtimeEpoch: 1
    });
    const targetA = targetFor(viewA);
    const targetB = targetFor(viewB);
    const detachReasons = [];
    const gatewayA = new ScopedCdpGateway({ target: targetA, onDetached: (reason) => detachReasons.push(reason) });
    const gatewayB = new ScopedCdpGateway({ target: targetB });
    gateways.push(gatewayA, gatewayB);
    const [cdpUrlA, cdpUrlB] = await Promise.all([gatewayA.start(), gatewayB.start()]);
    const listB = await (await fetch(`${cdpUrlB}/json/list`)).json();
    report.neighbourListsOnlyItself = listB.length === 1 && listB[0].id === targetB.targetId;
    report.capabilityRequired = (await fetch(`${new URL(cdpUrlA).origin}/json/list`)).status === 404;

    // Clicks the agent synthesizes must never count as the user selecting card A.
    let userSelections = 0;
    viewA.webContents.on('input-event', (_event, input) => {
      if (input.type === 'mouseDown' && !isSyntheticInputInFlight(viewA.webContents)) userSelections += 1;
    });

    child = spawn(python, [path.join(root, 'agent-runtime', 'compat_trace.py')], {
      cwd: path.join(root, 'agent-runtime'),
      env: { PATH: process.env.PATH, LANG: process.env.LANG, HOME: process.env.HOME, TMPDIR: userData, PYTHONUNBUFFERED: '1', ANONYMIZED_TELEMETRY: 'false' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-20_000); });
    const lines = readline.createInterface({ input: child.stdout });
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({ type: 'config', cdpUrl: cdpUrlA, ownTargetId: targetA.targetId, foreignTargetId: targetB.targetId, pageUrl: `${origin}/card-a`, nextUrl: `${origin}/card-a-next` });

    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`The trace did not finish in time.\n${stderr}`)), 120_000);
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`The trace exited with ${code} before reporting.\n${stderr}`));
      });
      lines.on('line', async (line) => {
        const message = JSON.parse(line);
        if (message.type === 'phase' && message.phase === 'hide') {
          // As when the card is off screen, covered, minimized or the window is hidden: Chromium stops producing frames.
          viewA.setVisible(false);
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
          report.pageHiddenBeforeScreenshot = await viewA.webContents.executeJavaScript('document.visibilityState');
          send({ type: 'ack' });
        } else if (message.type === 'phase' && message.phase === 'hidden-captured') {
          report.visibilityChangesDuringHiddenCapture = await viewA.webContents.executeJavaScript('window.visibilityChanges');
          send({ type: 'ack' });
        } else if (message.type === 'result') {
          clearTimeout(timer);
          if (message.error) reject(new Error(`${message.error}\n${stderr}`));
          else resolve(message.checks);
        }
      });
    });
    report.checks = result;
    report.userSelectionsFromAgentInput = userSelections;
    report.neighbourUrl = viewB.webContents.getURL();
    await Promise.all(gateways.map((gateway) => gateway.stop()));
    report.debuggerReleased = !viewA.webContents.debugger.isAttached() && !viewB.webContents.debugger.isAttached();
    report.detachReasons = detachReasons;

    const booleans = ['onlyOwnTarget', 'visibleScreenshot', 'initialUrl', 'hiddenScreenshot', 'clickUpdatesTitle', 'typedText',
      'navigationUpdatesUrl', 'deniesNewTab', 'deniesForeignTarget', 'deniesLocalFile', 'deniesCookieExport',
      'deniesStorageCookies', 'deniesPageClose', 'urlAfterDenials'];
    report.failedChecks = booleans.filter((name) => result[name] !== true);
    report.passed = report.failedChecks.length === 0
      && result.interactiveElements >= 2
      && result.hiddenStateSeconds < 10
      && report.pageHiddenBeforeScreenshot === 'hidden'
      // Hiding the card is the only visibility change the page may observe: captures never make it visible.
      && JSON.stringify(report.visibilityChangesDuringHiddenCapture) === JSON.stringify(['hidden'])
      && userSelections === 0
      && report.neighbourListsOnlyItself && report.capabilityRequired
      && report.neighbourUrl === `${origin}/card-b`
      && report.debuggerReleased;
  } catch (error) {
    report.error = error instanceof Error ? error.stack : String(error);
  } finally {
    child?.kill();
    await Promise.all(gateways.map((gateway) => gateway.stop().catch(() => undefined)));
    server.close();
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    app.exit(0);
  }
});
