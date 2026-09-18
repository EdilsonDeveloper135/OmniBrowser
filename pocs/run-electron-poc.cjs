const fs = require('node:fs');
const path = require('node:path');
const { startFixtureServer } = require('./lib/fixture-server.cjs');
const { runElectron } = require('./lib/run-electron.cjs');
const { createWorkingDirectory } = require('./lib/working-directory.cjs');

const name = process.argv[2];
if (!['agent', 'canvas', 'gestures', 'popup', 'resources'].includes(name)) {
  console.error('Usage: node pocs/run-electron-poc.cjs <agent|canvas|gestures|popup|resources>');
  process.exit(2);
}
// The agent trace needs a Python with agent-runtime/requirements.lock installed, such as the virtual environment
// agent:build creates (agent-runtime/.venv-<arch>/bin/python). A path is resolved against the working directory.
const configuredPython = process.env.OMNIBROWSER_AGENT_PYTHON || 'python3';
const agentPython = configuredPython.includes(path.sep) ? path.resolve(configuredPython) : configuredPython;

(async () => {
  const root = path.resolve(__dirname, '..');
  const working = createWorkingDirectory(name);
  const workingDirectory = working.directory;
  let passed = false;
  const output = path.join(workingDirectory, 'result.json');
  const screenshot = path.join(workingDirectory, 'canvas.png');
  const userData = path.join(workingDirectory, 'user-data');
  const server = name === 'popup' || name === 'resources' ? await startFixtureServer() : null;
  try {
    const args = [`--output=${output}`, `--user-data=${userData}`];
    if (server) args.push(`--origin=${server.origin}`);
    if (name === 'canvas') args.push(`--screenshot=${screenshot}`);
    if (name === 'agent') args.push(`--python=${agentPython}`);
    const entry = name === 'agent' ? 'agent-gateway-main.cjs' : `${name}-main.cjs`;
    await runElectron(path.join(__dirname, entry), args, { cwd: root });
    const report = JSON.parse(fs.readFileSync(output, 'utf8'));
    if (report.passed !== true) throw new Error(`${name} POC did not pass: ${JSON.stringify(report, null, 2)}`);
    if (name === 'canvas') {
      // Without Screen Recording permission macOS only returns the shell surface; the POC then checks the selected view
      // through its page instead of the composed pixels. CI requires the composed capture.
      const composite = report.captureMethod !== 'shell-only-capturePage';
      if (!composite && process.env.OMNIBROWSER_REQUIRE_COMPOSITE_CAPTURE === '1') {
        throw new Error(`canvas POC could not capture the composed window: ${report.captureLimitation}`);
      }
      if (!composite) process.stderr.write(`warning: canvas POC verified the selected view without a composed capture (${report.captureMethod}).\n`);
      const captureDirectory = path.join(root, 'test-results', 'poc');
      fs.mkdirSync(captureDirectory, { recursive: true });
      const capture = path.join(captureDirectory, `canvas-${process.arch}.png`);
      fs.copyFileSync(screenshot, capture);
      report.screenshotPath = path.relative(root, capture);
      // Committed evidence is only replaced on explicit request, and never by a capture that lacks the native views.
      if (process.env.OMNIBROWSER_UPDATE_VISUAL_EVIDENCE === '1') {
        if (!composite) throw new Error('docs/poc-results was not updated: the capture does not include the native views.');
        const evidenceDirectory = path.join(root, 'docs', 'poc-results');
        fs.mkdirSync(evidenceDirectory, { recursive: true });
        fs.copyFileSync(screenshot, path.join(evidenceDirectory, `canvas-${process.arch}.png`));
      }
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    passed = true;
  } finally {
    if (server) await server.close();
    working.release(passed);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
