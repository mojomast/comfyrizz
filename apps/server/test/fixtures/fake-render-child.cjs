const fs = require('fs');
const { spawn } = require('child_process');

process.on('SIGTERM', () => {
  try { fs.writeFileSync(`${process.env.COMFYRIZZ_CHILD_PID}.signal`, 'term'); } catch { /* the test only reads this when it exists */ }
  setTimeout(() => process.exit(0), Number(process.env.COMFYRIZZ_TERM_MS || 1500));
});

const pidFile = process.env.COMFYRIZZ_CHILD_PID;
const grandFile = process.env.COMFYRIZZ_GRAND_PID;
if (pidFile) fs.writeFileSync(pidFile, String(process.pid));
if (process.env.COMFYRIZZ_HOLD === '1') {
  const grand = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  if (grandFile && grand.pid) fs.writeFileSync(grandFile, String(grand.pid));
  setInterval(() => {}, 1000);
}
