const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, WebContentsView } = require('electron');

// Gate for trackpad gestures over native views (docs/architecture.md). Panning the canvas from a two-finger scroll over
// an inactive browser, or navigating history from a horizontal swipe, is only safe if the main process can consume the
// wheel input before the page scrolls. This POC records which Electron hooks see wheel input and whether cancelling
// them stops the page. It passes while the premise of the gate holds; if an Electron upgrade makes it fail, the gate can
// be reconsidered. Input is synthesized with webContents.sendInputEvent, which enters the same
// RenderWidgetHostImpl::ForwardWheelEventWithLatencyInfo path as native wheel events after macOS hit-testing; it does not
// replace the physical trackpad matrix.

function argument(name) {
  const prefix = `--${name}=`;
  const value = process.argv.find((entry) => entry.startsWith(prefix));
  if (!value) throw new Error(`Missing required ${prefix}<value> argument.`);
  return value.slice(prefix.length);
}

const output = argument('output');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const page = (body, script = '') => `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><style>html,body{margin:0}</style></head><body>${body}<script>${script}</script></body></html>`)}`;
const counters = "window.__events = { wheel: 0, mousedown: 0 }; addEventListener('wheel', () => { window.__events.wheel += 1; }, { passive: true }); addEventListener('mousedown', () => { window.__events.mousedown += 1; });";
const tally = (types) => types.reduce((counts, type) => ({ ...counts, [type]: (counts[type] ?? 0) + 1 }), {});

app.on('window-all-closed', () => undefined);

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1100, height: 760, useContentSize: true, title: 'OmniBrowser Gestures POC', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  const view = new WebContentsView({ webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  try {
    await window.loadURL(page('<div style="height:760px;background:#0b1118"></div>', counters));
    window.contentView.addChildView(view);
    view.setBounds({ x: 220, y: 64, width: 640, height: 480 });
    await view.webContents.loadURL(page('<div style="height:6000px;background:linear-gradient(#fff,#2f81f7)"></div>', counters));
    // Same foreground requirement as the canvas POC: an unshown window does not deliver input to its views reliably.
    window.show();
    window.focus();
    await wait(300);

    const seen = { beforeMouseEvent: [], inputEvent: [], beforeInputEvent: [], swipe: 0 };
    view.webContents.on('before-mouse-event', (event, mouse) => { seen.beforeMouseEvent.push(mouse.type); event.preventDefault(); });
    view.webContents.on('input-event', (event, input) => { seen.inputEvent.push(input.type); event.preventDefault(); });
    view.webContents.on('before-input-event', (event, input) => { seen.beforeInputEvent.push(input.type); event.preventDefault(); });
    window.on('swipe', () => { seen.swipe += 1; });
    const pageState = () => view.webContents.executeJavaScript('({ scrollX, scrollY, ...window.__events })', true);

    // Control: a mouse press reaches before-mouse-event and cancelling it keeps it from the page.
    view.webContents.sendInputEvent({ type: 'mouseDown', x: 60, y: 60, button: 'left', clickCount: 1 });
    view.webContents.sendInputEvent({ type: 'mouseUp', x: 60, y: 60, button: 'left', clickCount: 1 });
    await wait(300);
    const mouse = { pageMouseDowns: (await pageState()).mousedown, beforeMouseEvent: tally(seen.beforeMouseEvent) };

    // Two-finger vertical scroll, trackpad-style deltas. Every hook that sees it cancels it.
    seen.beforeMouseEvent.length = 0;
    for (let step = 0; step < 12; step += 1) {
      view.webContents.sendInputEvent({ type: 'mouseWheel', x: 200, y: 200, deltaX: 0, deltaY: -40, hasPreciseScrollingDeltas: true, canScroll: true });
      await wait(16);
    }
    await wait(600);
    const verticalPage = await pageState();
    const vertical = {
      pageScrollY: verticalPage.scrollY,
      pageWheelEvents: verticalPage.wheel,
      shellWheelEvents: (await window.webContents.executeJavaScript('window.__events.wheel', true)),
      beforeMouseEvent: tally(seen.beforeMouseEvent),
      inputEvent: tally(seen.inputEvent),
      beforeInputEvent: tally(seen.beforeInputEvent)
    };

    // Horizontal swipe on a page with history: overscroll towards Back, then scroll the other way.
    await view.webContents.loadURL(page('<div>first</div>'));
    await view.webContents.loadURL(page('<div style="width:4000px;height:100px">second</div>', counters));
    await wait(300);
    const historyBefore = view.webContents.navigationHistory.getActiveIndex();
    for (let step = 0; step < 12; step += 1) {
      view.webContents.sendInputEvent({ type: 'mouseWheel', x: 200, y: 60, deltaX: 60, deltaY: 0, hasPreciseScrollingDeltas: true, canScroll: true });
      await wait(16);
    }
    await wait(800);
    const historyAfterOverscroll = view.webContents.navigationHistory.getActiveIndex();
    for (let step = 0; step < 12; step += 1) {
      view.webContents.sendInputEvent({ type: 'mouseWheel', x: 200, y: 60, deltaX: -60, deltaY: 0, hasPreciseScrollingDeltas: true, canScroll: true });
      await wait(16);
    }
    await wait(800);
    const horizontal = {
      historyBefore,
      historyAfterOverscroll,
      historyAfterScroll: view.webContents.navigationHistory.getActiveIndex(),
      pageScrollX: (await pageState()).scrollX,
      swipeEvents: seen.swipe
    };

    const assertions = {
      beforeMouseEventCancelsMousePresses: mouse.beforeMouseEvent.mouseDown === 1 && mouse.pageMouseDowns === 0,
      beforeMouseEventNeverSeesWheel: !('mouseWheel' in vertical.beforeMouseEvent),
      beforeInputEventNeverSeesWheel: Object.keys(vertical.beforeInputEvent).length === 0,
      inputEventOnlyObservesWheel: (vertical.inputEvent.mouseWheel ?? 0) > 0 && vertical.pageWheelEvents > 0 && vertical.pageScrollY > 0,
      shellReceivesNoWheelForTheView: vertical.shellWheelEvents === 0,
      noBuiltInHistorySwipe: horizontal.historyAfterOverscroll === horizontal.historyBefore && horizontal.historyAfterScroll === horizontal.historyBefore && horizontal.swipeEvents === 0,
      horizontalWheelScrollsThePage: horizontal.pageScrollX > 0
    };
    const report = {
      poc: 'gesture-interception-gate',
      passed: Object.values(assertions).every(Boolean),
      electron: process.versions.electron,
      platform: process.platform,
      architecture: process.arch,
      conclusion: 'No main-process hook can cancel wheel input before a WebContentsView scrolls: gesture panning over browsers and history swipe stay disabled.',
      assertions,
      mouse,
      vertical,
      horizontal
    };
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
    window.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
    window.destroy();
    app.exit(report.passed ? 0 : 1);
  } catch (error) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify({ poc: 'gesture-interception-gate', passed: false, error: error instanceof Error ? error.stack : String(error) }, null, 2));
    if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
    if (!window.isDestroyed()) window.destroy();
    app.exit(1);
  }
});
