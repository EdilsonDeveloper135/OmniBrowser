const { execFile } = require('node:child_process');
const { access, constants, cp, lstat, lutimes, readdir, utimes } = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const { MakerDMG } = require('@electron-forge/maker-dmg');
const { MakerZIP } = require('@electron-forge/maker-zip');
const { WebpackPlugin } = require('@electron-forge/plugin-webpack');
const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseVersion, FuseV1Options } = require('@electron/fuses');

const macSignIdentity = process.env.OMNIBROWSER_MAC_SIGN_IDENTITY;
const skipAdHocSign = process.env.OMNIBROWSER_SKIP_ADHOC_SIGN === '1';
const execFileAsync = promisify(execFile);
// The Browser Use sidecar (agent-runtime/build.sh) is built per architecture on a native runner. E2E packages use the
// inert test stub instead: OMNIBROWSER_AGENT_RESOURCE_PATH=agent-runtime/test-stub.
const sidecarOverride = process.env.OMNIBROWSER_AGENT_RESOURCE_PATH;
// A package with the stub cannot run agents. It gets its own folder so it never replaces the real application in out/.
const packagesTestStub = sidecarOverride !== undefined && path.basename(path.resolve(sidecarOverride)) === 'test-stub';

// Electron's release zips date every entry 1980-01-01. The extractor that package.json overrides into
// @electron/packager@18 restores those dates, so the tree is re-dated to the packaging time, as @electron/packager
// 20.2.0 does after the same extractor (electron/packager#1940). Symlinks are re-dated without touching their targets.
async function resetTimestamps(directory, timestamp) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await resetTimestamps(entryPath, timestamp);
    else if (entry.isSymbolicLink()) await lutimes(entryPath, timestamp, timestamp);
    else await utimes(entryPath, timestamp, timestamp);
  }
  await utimes(directory, timestamp, timestamp);
}

async function collectFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

/** Copies the sidecar built for the architecture being packaged next to app.asar, outside the archive. */
async function copySidecar(buildPath, arch) {
  if (arch !== 'arm64' && arch !== 'x64') throw new Error(`OmniBrowser packages the agent sidecar for arm64 or x64, not ${arch}.`);
  const source = path.resolve(sidecarOverride || path.join('agent-runtime', 'dist', arch, 'agent-host'));
  try {
    await access(path.join(source, 'agent-host'), constants.X_OK);
  } catch {
    throw new Error(`The ${arch} agent sidecar is missing at ${source}. Run "npm run agent:build" on a native ${arch} Mac `
      + '(Python 3.12), or package for E2E tests with "npm run package:test".');
  }
  await cp(source, path.join(path.dirname(buildPath), path.basename(source)), { recursive: true, verbatimSymlinks: true });
}

async function signSidecar(appPath, identity) {
  const resources = path.join(appPath, 'Contents', 'Resources');
  const candidates = [path.join(resources, 'agent-host'), path.join(resources, 'test-stub')];
  const roots = [];
  for (const candidate of candidates) {
    try {
      if ((await lstat(candidate)).isDirectory()) roots.push(candidate);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (roots.length !== 1) throw new Error('The package must contain exactly one agent sidecar resource.');
  if (path.basename(roots[0]) === 'test-stub') return;
  const files = (await collectFiles(roots[0])).sort((left, right) => right.length - left.length);
  for (const file of files) {
    const { stdout } = await execFileAsync('/usr/bin/file', ['-b', file]);
    if (!stdout.includes('Mach-O')) continue;
    await execFileAsync('/usr/bin/codesign', ['--force', '--options', 'runtime', '--timestamp', '--sign', identity, file]);
  }
}

module.exports = {
  outDir: process.env.OMNIBROWSER_OUT_DIR || (packagesTestStub ? path.join('out', 'test-stub') : 'out'),
  packagerConfig: {
    asar: true,
    name: 'OmniBrowser',
    executableName: 'OmniBrowser',
    appBundleId: 'org.omnibrowser.desktop',
    appCategoryType: 'public.app-category.productivity',
    osxSign: macSignIdentity
      ? { identity: macSignIdentity, continueOnError: false, hardenedRuntime: true }
      : undefined,
    extendInfo: {
      LSMinimumSystemVersion: '13.0',
      NSHumanReadableCopyright: 'Copyright © 2026 OmniBrowser contributors'
    }
  },
  rebuildConfig: {},
  hooks: {
    packageAfterExtract: async (_forgeConfig, buildPath) => {
      await resetTimestamps(buildPath, new Date());
    },
    // buildPath is Contents/Resources/app, before it becomes app.asar.
    packageAfterCopy: async (_forgeConfig, buildPath, _electronVersion, platform, arch) => {
      if (platform === 'darwin') await copySidecar(buildPath, arch);
    },
    postPackage: async (_forgeConfig, packageResult) => {
      if (packageResult.platform !== 'darwin') return;
      await Promise.all(packageResult.outputPaths.map(async (outputPath) => {
        const appPath = path.join(outputPath, 'OmniBrowser.app');
        if (!macSignIdentity && skipAdHocSign) return;
        await execFileAsync('/usr/bin/xattr', ['-cr', appPath]);
        if (macSignIdentity) {
          await signSidecar(appPath, macSignIdentity);
          await execFileAsync('/usr/bin/codesign', [
            '--force', '--options', 'runtime', '--timestamp',
            '--preserve-metadata=entitlements,requirements', '--sign', macSignIdentity, appPath
          ]);
        } else {
          await execFileAsync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath]);
        }
        // Development workspaces managed by File Provider can immediately re-add FinderInfo/provenance xattrs after
        // ad-hoc signing. Release runners are not allowed to skip the strict verification gate.
        if (macSignIdentity) {
          await execFileAsync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
        }
      }));
    }
  },
  makers: [
    new MakerZIP({}, ['darwin']),
    new MakerDMG({ format: 'ULFO' }, ['darwin'])
  ],
  plugins: [
    new WebpackPlugin({
      mainConfig: './webpack.main.config.cjs',
      renderer: {
        config: './webpack.renderer.config.cjs',
        entryPoints: [{
          html: './src/renderer/index.html',
          js: './src/renderer/index.tsx',
          name: 'main_window',
          preload: { js: './src/preload/index.ts' }
        }]
      },
      // Forge's default development CSP allows 'unsafe-eval' and inline scripts; the shell needs neither. Only the
      // webpack live-reload socket on localhost is added to the packaged policy.
      devContentSecurityPolicy: "default-src 'self'; script-src 'self'; style-src 'self'; style-src-elem 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://localhost:*; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'",
      devServer: {
        // webpack-dev-server listens on every interface when no host is given; the renderer entry is localhost-only.
        host: 'localhost',
        client: { overlay: false },
        headers: {
          'Cross-Origin-Opener-Policy': 'same-origin',
          'X-Content-Type-Options': 'nosniff'
        }
      }
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false
    })
  ]
};
