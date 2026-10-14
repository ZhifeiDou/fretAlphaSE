const path = require('node:path');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const webpack = require('webpack');

const sourceRoot = path.resolve(__dirname, '../fret-electron');
const sourceHash = createHash('sha256');
for (const directory of ['app/parser', 'support', 'analysis']) {
  for (const file of fs.readdirSync(path.join(sourceRoot, directory), { recursive: true }).sort()) {
    const absolute = path.join(sourceRoot, directory, file);
    if (fs.statSync(absolute).isFile()) {
      sourceHash.update(`${directory}/${file.replaceAll('\\', '/')}\0`);
      sourceHash.update(fs.readFileSync(absolute));
    }
  }
}

module.exports = {
  mode: 'production',
  target: 'node22',
  context: __dirname,
  entry: {
    formalize: './src/formalize.js',
    server: './src/server.js',
    worker: './src/worker.js',
    analysis: './src/analysis.js',
    'analysis-worker': './src/analysis-worker.js'
  },
  output: {
    path: path.join(__dirname, 'dist'),
    filename: '[name].cjs',
    library: { type: 'commonjs2' }
  },
  // These server libraries run as ordinary, locked Node dependencies. The
  // formalizer and worker still bundle FRET, its semantic tables, and schemas.
  externals: [/^(@modelcontextprotocol\/sdk|express|smol-toml|ejs)(\/|$)/],
  module: { rules: [
    { test: /\.js$/, include: sourceRoot, type: 'javascript/auto' },
    { test: /\.ejs$/, type: 'asset/source' }
  ] },
  plugins: [new webpack.DefinePlugin({ FRET_SOURCE_DIGEST: JSON.stringify(`sha256:${sourceHash.digest('hex')}`) })],
  node: { __dirname: false, __filename: false },
  resolve: {
    // FRET source lives outside this package; use this package's locked deps.
    modules: [path.join(__dirname, 'node_modules')]
  },
  optimization: {
    minimize: false,
    emitOnErrors: false
  },
  bail: true,
  stats: 'minimal'
};
