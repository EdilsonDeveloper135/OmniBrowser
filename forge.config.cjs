const { execFile } = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');
const { MakerDMG } = require('@electron-forge/maker-dmg');
const { MakerZIP } = require('@electron-forge/maker-zip');
const { WebpackPlugin } = require('@electron-forge/plugin-webpack');
const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseVersion, FuseV1Options } = require('@electron/fuses');

const macSignIdentity = process.env.OMNIBROWSER_MAC_SIGN_IDENTITY;
const execFileAsync = promisify(execFile);

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
      devServer: {
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
