// E2E entry point: runs the production main bundle, but serves the shell's JavaScript late so that the renderer subscribes
// to events after work that starts together with the window. Only responses of omnibrowser:// are delayed; nothing else
// in the bundle changes.
const { protocol } = require('electron');

const bundle = process.env.OMNIBROWSER_MAIN_BUNDLE;
const delayMs = Number(process.env.OMNIBROWSER_TEST_SHELL_SCRIPT_DELAY_MS);
if (!bundle || !Number.isFinite(delayMs) || delayMs <= 0) {
  throw new Error('OMNIBROWSER_MAIN_BUNDLE and a positive OMNIBROWSER_TEST_SHELL_SCRIPT_DELAY_MS are required.');
}

const handle = protocol.handle.bind(protocol);
protocol.handle = (scheme, handler) => handle(scheme, async (request) => {
  if (new URL(request.url).pathname.endsWith('.js')) await new Promise((resolve) => setTimeout(resolve, delayMs));
  return handler(request);
});

require(bundle);
