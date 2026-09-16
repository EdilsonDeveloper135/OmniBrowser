const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startFixtureServer } = require('./lib/fixture-server.cjs');
const { runElectron } = require('./lib/run-electron.cjs');

const name = process.argv[2];
if (!['canvas', 'popup', 'resources'].includes(name)) {
  console.error('Usage: node pocs/run-electron-poc.cjs <canvas|popup|resources>');
  process.exit(2);
}

(async () => {
  const root = path.resolve(__dirname, '..');
  const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), `omnibrowser-${name}-poc-`));
  const output = path.join(workingDirectory, 'result.json');
  const screenshot = path.join(workingDirectory, 'canvas.png');
  const userData = path.join(workingDirectory, 'user-data');
  const server = name === 'canvas' ? null : await startFixtureServer();
  try {
    const args = [`--output=${output}`, `--user-data=${userData}`];
    if (server) args.push(`--origin=${server.origin}`);
    if (name === 'canvas') args.push(`--screenshot=${screenshot}`);
    await runElectron(path.join(__dirname, `${name}-main.cjs`), args, { cwd: root });
    const report = JSON.parse(fs.readFileSync(output, 'utf8'));
    if (report.passed !== true) throw new Error(`${name} POC did not pass: ${JSON.stringify(report, null, 2)}`);
    if (name === 'canvas') {
      const evidenceDirectory = path.join(root, 'docs', 'poc-results');
      fs.mkdirSync(evidenceDirectory, { recursive: true });
      fs.copyFileSync(screenshot, path.join(evidenceDirectory, `canvas-${process.arch}.png`));
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    if (server) await server.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
