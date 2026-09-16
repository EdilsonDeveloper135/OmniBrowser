const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const scripts = [
  ['profiles-and-storage', path.join(__dirname, 'run-storage.cjs')],
  ['native-canvas-composition', path.join(__dirname, 'run-electron-poc.cjs'), 'canvas'],
  ['popup-and-auth-flow', path.join(__dirname, 'run-electron-poc.cjs'), 'popup'],
  ['resource-lifecycle', path.join(__dirname, 'run-electron-poc.cjs'), 'resources']
];

for (const [name, script, ...args] of scripts) {
  process.stdout.write(`\n=== ${name} ===\n`);
  const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
