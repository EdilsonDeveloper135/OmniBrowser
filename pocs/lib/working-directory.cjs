const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Temporary directory for one POC run: result files and the Chromium profile. A passing run removes it so repeated runs
 * do not accumulate profiles in the temp directory; a failing run keeps it and prints where it is, for inspection.
 */
function createWorkingDirectory(name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `omnibrowser-${name}-poc-`));
  return {
    directory,
    release(passed) {
      if (!passed) {
        process.stderr.write(`POC working directory kept for inspection: ${directory}\n`);
        return;
      }
      try {
        // Chromium helpers can still be closing files for a moment after the main process exits.
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch (error) {
        process.stderr.write(`warning: could not remove the POC working directory ${directory}: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  };
}

module.exports = { createWorkingDirectory };
