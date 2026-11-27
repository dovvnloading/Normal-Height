#!/usr/bin/env node
import { createServer } from 'vite';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const controller = new AbortController();
const cancel = () => controller.abort(new DOMException('Cancelled.', 'AbortError'));
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
let server;
try {
  let build = { revision: 'unknown', dirty: null, source: 'unknown' };
  try {
    const git = (arguments_) =>
      execFileSync('git', arguments_, {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    build = {
      revision: git(['rev-parse', 'HEAD']),
      dirty: git(['status', '--porcelain', '--untracked-files=normal']).length > 0,
      source: 'git',
    };
  } catch {
    /* Source archives have honest unknown provenance. */
  }
  server = await createServer({
    root,
    configFile: false,
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true, hmr: false, watch: null },
    define: { __NH_BUILD_INFO__: JSON.stringify(build) },
  });
  const { runCLI } = await server.ssrLoadModule('/src/cli/main.ts');
  process.exitCode = await runCLI(args, { signal: controller.signal });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (args.includes('--json'))
    process.stdout.write(
      JSON.stringify({
        schemaVersion: 1,
        ok: false,
        error: { code: 'STARTUP', message },
      }) + '\n',
    );
  else process.stderr.write(`Normal Height CLI could not start: ${message}\n`);
  process.exitCode = controller.signal.aborted ? 130 : 1;
} finally {
  await server?.close();
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
}
