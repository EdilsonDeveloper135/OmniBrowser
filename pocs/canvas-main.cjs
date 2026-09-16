const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { app, BrowserWindow, WebContentsView, desktopCapturer, nativeImage, screen } = require('electron');

function argument(name) {
  const prefix = `--${name}=`;
  const value = process.argv.find((entry) => entry.startsWith(prefix));
  if (!value) throw new Error(`Missing required ${prefix}<value> argument.`);
  return value.slice(prefix.length);
}

const output = argument('output');
const screenshotPath = argument('screenshot');
const origin = { x: 220, y: 64 };
const camera = { panX: 18, panY: -12, zoom: 0.8 };
const viewport = { x: 220, y: 64, width: 980, height: 686 };

function project(worldRect, nextCamera = camera) {
  return {
    x: Math.round(origin.x + nextCamera.panX + worldRect.x * nextCamera.zoom),
    y: Math.round(origin.y + nextCamera.panY + worldRect.y * nextCamera.zoom),
    width: Math.round(worldRect.width * nextCamera.zoom),
    height: Math.round(worldRect.height * nextCamera.zoom)
  };
}

function intersects(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function colorDistance(actual, expected) {
  return Math.abs(actual.red - expected.red) + Math.abs(actual.green - expected.green) + Math.abs(actual.blue - expected.blue);
}

function sample(nativeImage, dipX, dipY, contentSize) {
  const imageSize = nativeImage.getSize();
  const pixelX = Math.max(0, Math.min(imageSize.width - 1, Math.floor(dipX * imageSize.width / contentSize.width)));
  const pixelY = Math.max(0, Math.min(imageSize.height - 1, Math.floor(dipY * imageSize.height / contentSize.height)));
  const bitmap = nativeImage.toBitmap();
  const offset = (pixelY * imageSize.width + pixelX) * 4;
  return { blue: bitmap[offset], green: bitmap[offset + 1], red: bitmap[offset + 2], alpha: bitmap[offset + 3] };
}

const remotePage = (color, label) => `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:${color};color:#fff;font:600 28px system-ui}</style></head><body>${label}</body></html>`;
const shellPage = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>html,body{margin:0;height:100%;overflow:hidden;background:#0b1118}body{background-image:radial-gradient(#284053 1px,transparent 1px);background-size:24px 24px}.rail{position:absolute;inset:0 auto 0 0;width:220px;background:#101720;border-right:1px solid #26313c}.toolbar{position:absolute;left:220px;right:0;top:0;height:64px;background:#101720;border-bottom:1px solid #26313c}</style></head><body><aside class="rail"></aside><header class="toolbar"></header></body></html>`;

async function createView(window, definition) {
  const view = new WebContentsView({ webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: true } });
  window.contentView.addChildView(view);
  await view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(remotePage(definition.color, definition.label))}`);
  return view;
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1200,
    height: 750,
    useContentSize: true,
    titleBarStyle: 'hidden',
    title: 'OmniBrowser Canvas POC',
    backgroundColor: '#0b1118',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true }
  });
  const definitions = [
    { label: 'A', color: 'rgb(210, 60, 80)', world: { x: 80, y: 80, width: 460, height: 320 } },
    { label: 'B', color: 'rgb(48, 180, 120)', world: { x: 300, y: 210, width: 440, height: 300 } },
    { label: 'C', color: 'rgb(90, 105, 220)', world: { x: 1900, y: 1500, width: 400, height: 280 } }
  ];
  const views = [];

  try {
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(shellPage)}`);
    for (const definition of definitions) views.push(await createView(window, definition));
    const initialBounds = definitions.map((definition, index) => {
      const bounds = project(definition.world);
      views[index].setBounds(bounds);
      views[index].setVisible(intersects(bounds, viewport));
      return bounds;
    });

    const transformedCamera = { panX: -42, panY: 36, zoom: 1.1 };
    definitions[0].world = { ...definitions[0].world, width: 520, height: 350 };
    const transformedBounds = definitions.map((definition, index) => {
      const bounds = project(definition.world, transformedCamera);
      views[index].setBounds(bounds);
      views[index].setVisible(intersects(bounds, viewport));
      return bounds;
    });

    window.contentView.addChildView(views[0]);
    window.showInactive();
    await new Promise((resolve) => setTimeout(resolve, 350));
    const children = window.contentView.children;
    const topChildIsReaddedView = children[children.length - 1] === views[0];
    let capture = null;
    let captureMethod = 'desktopCapturer';
    let captureLimitation = null;
    try {
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 1200, height: 750 },
        fetchWindowIcons: false
      });
      const source = sources.find((candidate) => candidate.id === window.getMediaSourceId()) || sources.find((candidate) => candidate.name === 'OmniBrowser Canvas POC');
      if (source && !source.thumbnail.isEmpty()) capture = source.thumbnail;
    } catch (error) {
      captureLimitation = error instanceof Error ? error.message : String(error);
    }
    if (!capture) {
      captureMethod = 'macOS-screencapture';
      try {
        const windowId = window.getMediaSourceId().split(':')[1];
        execFileSync('/usr/sbin/screencapture', ['-x', '-l', windowId, screenshotPath]);
        const systemCapture = nativeImage.createFromPath(screenshotPath);
        if (!systemCapture.isEmpty()) capture = systemCapture;
      } catch (error) {
        captureLimitation = error instanceof Error ? error.message : String(error);
      }
    }
    if (!capture) {
      captureMethod = 'shell-only-capturePage';
      capture = await window.webContents.capturePage();
      captureLimitation = `macOS composed-window capture unavailable without Screen Recording permission${captureLimitation ? `: ${captureLimitation}` : ''}`;
    }
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    fs.writeFileSync(screenshotPath, capture.toPNG());

    const isCompositeCapture = captureMethod !== 'shell-only-capturePage';
    const sampledColor = isCompositeCapture
      ? sample(capture, Math.max(transformedBounds[0].x, transformedBounds[1].x) + 30, Math.max(transformedBounds[0].y, transformedBounds[1].y) + 30, window.getContentBounds())
      : null;
    const renderedSelectedViewIsRed = isCompositeCapture
      ? colorDistance(sampledColor, { red: 210, green: 60, blue: 80 }) < 90
      : await views[0].webContents.executeJavaScript("getComputedStyle(document.body).backgroundColor === 'rgb(210, 60, 80)'", true);
    const offscreenHidden = views[2].getVisible() === false;
    const expectedBoundsApplied = views.every((view, index) => JSON.stringify(view.getBounds()) === JSON.stringify(transformedBounds[index]));
    const report = {
      poc: 'native-canvas-composition',
      passed: topChildIsReaddedView && renderedSelectedViewIsRed && offscreenHidden && expectedBoundsApplied,
      electron: process.versions.electron,
      platform: process.platform,
      architecture: process.arch,
      scaleFactor: screen.getDisplayMatching(window.getBounds()).scaleFactor,
      camera: transformedCamera,
      initialBounds,
      transformedBounds,
      sampledOverlapColor: sampledColor,
      captureMethod,
      captureLimitation,
      assertions: { boundsTransform: expectedBoundsApplied, offscreenHidden, readdRaisesView: topChildIsReaddedView, selectedViewRendered: renderedSelectedViewIsRed },
      screenshotPath
    };
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
    for (const view of views) {
      window.contentView.removeChildView(view);
      if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
    }
    window.destroy();
    app.exit(report.passed ? 0 : 1);
  } catch (error) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify({ poc: 'native-canvas-composition', passed: false, error: error instanceof Error ? error.stack : String(error) }, null, 2));
    for (const view of views) if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
    if (!window.isDestroyed()) window.destroy();
    app.exit(1);
  }
});
