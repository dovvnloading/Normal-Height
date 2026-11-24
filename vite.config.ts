import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { BuildInfo } from './src/model/buildInfo.ts';

function sourceBuildInfo(): BuildInfo {
  try {
    const cwd = fileURLToPath(new URL('.', import.meta.url));
    const git = (args: string[]) =>
      execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    return {
      revision: git(['rev-parse', 'HEAD']),
      dirty: git(['status', '--porcelain', '--untracked-files=normal']).length > 0,
      source: 'git',
    };
  } catch {
    return { revision: 'unknown', dirty: null, source: 'unknown' };
  }
}
export default defineConfig({
  plugins: [react()],
  define: { __NH_BUILD_INFO__: JSON.stringify(sourceBuildInfo()) },
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
  server: { host: '0.0.0.0' },
});
