const esbuild = require('esbuild');
const path = require('node:path');
const options = {
  entryPoints: ['main', 'preload', 'background-worker'].map(name => path.resolve(__dirname, '../electron', `${name}.ts`)),
  outdir: path.resolve(__dirname, '../dist-electron'),
  outExtension: { '.js': '.cjs' },
  bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  tsconfig: path.resolve(__dirname, '../../../tsconfig.base.json'),
  external: ['electron', 'better-sqlite3', '@kutalia/whisper-node-addon'],
  sourcemap: true, logLevel: 'info'
};
(async () => {
  if (process.argv.includes('--watch')) { const context = await esbuild.context(options); await context.watch(); }
  else await esbuild.build(options);
})().catch(error => { console.error(error); process.exitCode = 1; });
