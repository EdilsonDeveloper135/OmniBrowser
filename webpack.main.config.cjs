const rules = require('./webpack.rules.cjs');

module.exports = {
  entry: './src/main/index.ts',
  target: 'electron-main',
  devtool: process.env.NODE_ENV === 'production' ? false : 'source-map',
  module: { rules },
  resolve: { extensions: ['.ts', '.tsx', '.js'] },
  optimization: { minimize: process.env.NODE_ENV === 'production' }
};
