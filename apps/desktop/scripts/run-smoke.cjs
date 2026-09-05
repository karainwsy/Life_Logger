const { spawn } = require('node:child_process');
const path = require('node:path');
require('esbuild').buildSync({
  entryPoints: [path.join(__dirname, 'clues-fixture.ts')], outfile: path.resolve(__dirname, '../../../.test-artifacts/clues-fixture.cjs'),
  bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  tsconfig: path.resolve(__dirname, '../../../tsconfig.base.json'), external: ['better-sqlite3']
});
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [path.join(__dirname, 'smoke-electron.cjs'), '--smoke-test'], { cwd: path.resolve(__dirname, '..'), env, stdio: 'inherit', windowsHide: true });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
