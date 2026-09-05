const { spawn } = require('node:child_process');
const path = require('node:path');
const electronVersion = require('electron/package.json').version;
if (!process.env.npm_execpath) throw new Error('请通过 npm run rebuild:native 执行');
const child = spawn(process.execPath, [process.env.npm_execpath, 'rebuild', 'better-sqlite3'], {
  cwd: path.resolve(__dirname, '../../..'), stdio: 'inherit', windowsHide: true,
  env: { ...process.env, npm_config_runtime: 'electron', npm_config_target: electronVersion, npm_config_disturl: 'https://electronjs.org/headers', npm_config_arch: process.arch }
});
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
