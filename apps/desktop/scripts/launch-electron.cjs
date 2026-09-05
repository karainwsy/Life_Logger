const { spawn } = require('node:child_process');
const path = require('node:path');

const appDir = path.resolve(__dirname, '..');
const electronBinary = require('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBinary, [appDir, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: appDir,
  env,
  windowsHide: true
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
