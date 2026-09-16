const { spawn } = require('node:child_process');
const electronBinary = require('electron');

function runElectron(entryPath, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(electronBinary, [entryPath, ...args], {
      cwd: options.cwd,
      env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1', ...options.env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`Electron POC failed (code=${code}, signal=${signal || 'none'}).\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
    });
  });
}

module.exports = { runElectron };
