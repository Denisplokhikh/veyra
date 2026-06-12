import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');
const env = { ...process.env };

delete env.ELECTRON_RUN_AS_NODE;

const args = process.argv.length > 2 ? process.argv.slice(2) : ['apps/desktop/main.js'];
const child = spawn(electronPath, args, {
  cwd: root,
  env,
  stdio: 'inherit'
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
