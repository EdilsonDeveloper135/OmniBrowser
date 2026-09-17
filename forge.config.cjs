const { execFile } = require('node:child_process');
const { lutimes, readdir, utimes } = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const { MakerDMG } = require('@electron-forge/maker-dmg');
const { MakerZIP } = require('@electron-forge/maker-zip');
const { WebpackPlugin } = require('@electron-forge/plugin-webpack');
const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseVersion, FuseV1Options } = require('@electron/fuses');

const macSignIdentity = process.env.OMNIBROWSER_MAC_SIGN_IDENTITY;
const execFileAsync = promisify(execFile);

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

module.exports = {
  outDir: process.env.OMNIBROWSER_OUT_DIR || 'out',
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
    postPackage: async (_forgeConfig, packageResult) => {
      if (packageResult.platform !== 'darwin' || macSignIdentity) return;
      await Promise.all(packageResult.outputPaths.map(async (outputPath) => {
        const appPath = path.join(outputPath, 'OmniBrowser.app');
        await execFileAsync('/usr/bin/xattr', ['-cr', appPath]);
        await execFileAsync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath]);
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
