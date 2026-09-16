const rules = require('./webpack.rules.cjs');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');

// See webpack.main.config.cjs: the build mode comes from Electron Forge, not from process.env at load time.
module.exports = (_env, { mode }) => ({
  target: 'web',
  devtool: mode === 'production' ? false : 'source-map',
  module: {
    rules: [
      ...rules,
      { test: /\.css$/, use: [MiniCssExtractPlugin.loader, 'css-loader'] }
    ]
  },
  plugins: [new MiniCssExtractPlugin({ filename: '[name].css' })],
  resolve: { extensions: ['.ts', '.tsx', '.js', '.css'] },
  optimization: { minimize: mode === 'production' }
});
