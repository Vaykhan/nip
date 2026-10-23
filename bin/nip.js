#!/usr/bin/env node
// NIP command-line entry point.
//
// The main thread only starts a worker thread with a large stack (so deep PHP recursion works) and
// forwards its exit code; the interpreter itself is loaded and run inside the worker.

import module from 'node:module';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';

try { module.enableCompileCache?.(); } catch (e) { /* optional */ }

if (isMainThread && !process.env.NIP_NO_WORKER) {
  let w = null;
  try {
    w = new Worker(new URL(import.meta.url), {
      argv: process.argv.slice(2),
      resourceLimits: { stackSizeMb: 256, maxOldGenerationSizeMb: 4096 },
      stdout: false, stderr: false, stdin: false,
    });
  } catch (e) { w = null; }
  if (w) {
    w.on('message', (m) => { if (m && m.exit !== undefined) process.exitCode = m.exit; });
    w.on('error', (e) => { process.stderr.write('PHP Fatal error:  ' + ((e && e.stack) || e) + '\n'); process.exitCode = 255; });
    w.on('exit', () => { process.exit(process.exitCode || 0); });
  } else {
    await runHere();
  }
} else {
  await runHere();
}

async function runHere() {
  await import('../src/index.js');
  const { main } = await import('../src/cli.js');
  const code = main(process.argv.slice(2));
  if (!isMainThread) parentPort.postMessage({ exit: code });
  else process.exitCode = code;
}
