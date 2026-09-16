const rules = require('./webpack.rules.cjs');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');

module.exports = {
  target: 'web',
  devtool: process.env.NODE_ENV === 'production' ? false : 'source-map',
  module: {
    rules: [
      ...rules,
      { test: /\.css$/, use: [MiniCssExtractPlugin.loader, 'css-loader'] }
    ]
  },
  plugins: [new MiniCssExtractPlugin({ filename: '[name].css' })],
  resolve: { extensions: ['.ts', '.tsx', '.js', '.css'] },
  optimization: { minimize: process.env.NODE_ENV === 'production' }
};
