// npm run dev — backend (tsx watch, dev origins allowed) + Vite dev server with API/WS proxy.
import { spawn } from 'node:child_process';

const env = { ...process.env, QO_DEV: '1' };
const opts = { stdio: 'inherit', shell: true, env };
const procs = [spawn('npx tsx watch src/server/main.ts', opts), spawn('npx vite', opts)];
const stop = () => procs.forEach((p) => p.kill());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
procs.forEach((p) => p.on('exit', (code) => { if (code) { stop(); process.exit(code); } }));
