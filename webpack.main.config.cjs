const rules = require('./webpack.rules.cjs');

// Electron Forge calls configuration factories with the build mode. process.env.NODE_ENV is not set yet when this file
// is evaluated, so reading it here would silently produce unminified packages with source maps.
module.exports = (_env, { mode }) => ({
  entry: './src/main/index.ts',
  target: 'electron-main',
  devtool: mode === 'production' ? false : 'source-map',
  module: { rules },
  resolve: { extensions: ['.ts', '.tsx', '.js'] },
  optimization: { minimize: mode === 'production' }
});
