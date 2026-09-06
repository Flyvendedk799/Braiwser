// Cross-platform e2e launcher. Sets BRAIWSER_E2E (and CAOS_E2E alias) then
// spawns Electron with the same args npm used to pass inline.
const { spawn } = require('child_process');
const path = require('path');
const electron = require('electron');

process.env.BRAIWSER_E2E = '1';
process.env.CAOS_E2E = '1';

const child = spawn(electron, [path.join(__dirname, '..'), '--no-sandbox'], {
  stdio: 'inherit',
  env: process.env,
});
child.on('exit', (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code || 0);
});
