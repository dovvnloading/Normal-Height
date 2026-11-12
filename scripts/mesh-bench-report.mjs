#!/usr/bin/env node
// Summarise tests/perf/mesh-perf.spec.ts output into a Markdown report for
// issue #34. Usage:
//   node scripts/mesh-bench-report.mjs [summaryDir ...] > report.md
// Each argument is a directory of per-case JSON files (default:
// mesh-benchmark-results/summary). Several directories (e.g. one run at 1x and
// one at 1.8x exaggeration) are merged and grouped by exaggeration.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const RAF_P95_TARGET_MS = 33.3;
const STALL_LIMIT_MS = 250;
const BUFFER_LIMIT_BYTES = 100_000_000;
const PHASES = ['idle', 'orbit', 'pan', 'zoom', 'focus', 'postLodIdle'];
const QUALITY_ORDER = ['balanced', 'high', 'ultra'];

const dirs = process.argv.slice(2);
if (!dirs.length) dirs.push('mesh-benchmark-results/summary');

const results = [];
for (const dir of dirs)
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.json')))
    results.push(JSON.parse(readFileSync(join(dir, name), 'utf8')));
if (!results.length) {
  console.error(`No benchmark JSON found in: ${dirs.join(', ')}`);
  process.exit(1);
}

const fmt = (v, digits = 1) => (v == null || !Number.isFinite(v) ? 'n/a' : v.toFixed(digits));
const mb = (bytes) => fmt(bytes / 1e6, 1);
const order = (r) => [
  r.case.exaggeration,
  r.case.resolution,
  QUALITY_ORDER.indexOf(r.case.quality),
  r.case.material,
  r.case.reference === 'uniform512' ? 0 : 1,
];
results.sort((a, b) => {
  const x = order(a);
  const y = order(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
});

const worstRaf = (r) => Math.max(...PHASES.map((p) => r.phases[p]?.rafGapsMs.worstMs ?? 0));
const worstP95 = (r) => Math.max(...PHASES.map((p) => r.phases[p]?.rafGapsMs.p95Ms ?? 0));
const worstLongTask = (r) =>
  Math.max(...PHASES.map((p) => r.phases[p]?.mainThreadLongTasksMs.worstMs ?? 0));
const live = (r) => r.final.meshBuilds - r.final.meshDisposals;

const failures = [];
for (const r of results) {
  const id = `${r.case.resolution}² ${r.case.quality} ${r.case.material} ${r.case.reference} ×${r.case.exaggeration}`;
  if (worstP95(r) > RAF_P95_TARGET_MS)
    failures.push(`${id}: RAF p95 ${fmt(worstP95(r))} ms > ${RAF_P95_TARGET_MS} ms`);
  if (worstLongTask(r) > STALL_LIMIT_MS)
    failures.push(
      `${id}: main-thread long task ${fmt(worstLongTask(r))} ms > ${STALL_LIMIT_MS} ms`,
    );
  if (live(r) !== 1) failures.push(`${id}: ${live(r)} live terrain meshes (expected 1)`);
  if (r.final.bufferEstimateBytes >= BUFFER_LIMIT_BYTES)
    failures.push(`${id}: geometry buffers ${mb(r.final.bufferEstimateBytes)} MB ≥ 100 MB`);
  if (r.case.material === 'pbr' && r.final.pbrUploads !== r.initial.pbrUploads)
    failures.push(`${id}: PBR re-uploaded during camera motion`);
}

const out = [];
const env = results[0].environment;
const devices = [...new Set(results.map((r) => r.deviceLabel))];
out.push('# Terrain mesh hardware benchmark');
out.push('');
out.push(`- **Device:** ${devices.join('; ')}`);
out.push(`- **WebGL renderer:** ${env.gpuRenderer}`);
out.push(
  `- **Viewport:** ${env.viewport.width}×${env.viewport.height} @ DPR ${env.viewport.dpr}, headless=${env.headless}, software=${env.software}`,
);
out.push(
  `- **Cases:** ${results.length}, run ${results[0].timestamp} – ${results.at(-1).timestamp}`,
);
out.push(
  `- **GPU timer query:** ${results.some((r) => r.gpuDrawTimeMs) ? 'supported' : 'not available'}`,
);
out.push('');
out.push('## Gate check');
out.push('');
out.push(
  `Targets from docs/MESH_PERFORMANCE.md: RAF p95 ≤ ${RAF_P95_TARGET_MS} ms in every phase, no main-thread task > ${STALL_LIMIT_MS} ms, exactly one live terrain mesh, geometry buffers < 100 MB, no PBR re-upload from camera motion.`,
);
out.push('');
out.push(failures.length ? failures.map((f) => `- ❌ ${f}`).join('\n') : '- ✅ All cases pass.');
out.push('');

for (const ex of [...new Set(results.map((r) => r.case.exaggeration))]) {
  const group = results.filter((r) => r.case.exaggeration === ex);
  out.push(`## Vertical exaggeration ×${ex}`);
  out.push('');
  out.push(
    '| Field | Quality | Material | Topology | Triangles | GPU draw p50 / p95 / p99 / worst (ms) | RAF p95 worst phase (ms) | RAF worst (ms) | Long task worst (ms) | Plan / last build CPU / worst frame of it (ms), frames | Buffers (MB) | Geometries | Ready (s) |',
  );
  out.push('|---|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|');
  for (const r of group) {
    const g = r.gpuDrawTimeMs;
    out.push(
      `| ${r.case.resolution}² | ${r.case.quality} | ${r.case.material} | ${r.case.reference} | ${r.final.triangles.toLocaleString('en-US')} | ${
        g
          ? `${fmt(g.p50Ms, 2)} / ${fmt(g.p95Ms, 2)} / ${fmt(g.p99Ms, 2)} / ${fmt(g.worstMs, 2)}`
          : 'n/a'
      } | ${fmt(worstP95(r))} | ${fmt(worstRaf(r))} | ${fmt(worstLongTask(r))} | ${fmt(
        r.final.lastMeshPlanCpuMs,
        2,
      )} / ${fmt(r.final.lastMeshBuildCpuMs, 1)} / ${fmt(r.final.lastMeshBuildMaxSliceMs, 1)}, ${
        r.final.lastMeshBuildFrames ?? 'n/a'
      } | ${mb(r.final.bufferEstimateBytes)} | ${
        r.final.geometryCount
      } | ${fmt(r.readinessMs / 1000)} |`,
    );
  }
  out.push('');

  out.push(`### Adaptive vs uniform 512 reference (×${ex})`);
  out.push('');
  out.push(
    '| Field | Quality | Material | Triangles adaptive / ref | GPU p95 adaptive / ref (ms) | GPU p95 ratio |',
  );
  out.push('|---|---|---|--:|--:|--:|');
  for (const a of group.filter((r) => r.case.reference === 'adaptive')) {
    const ref = group.find(
      (r) =>
        r.case.reference === 'uniform512' &&
        r.case.resolution === a.case.resolution &&
        r.case.quality === a.case.quality &&
        r.case.material === a.case.material,
    );
    if (!ref) continue;
    const ga = a.gpuDrawTimeMs?.p95Ms;
    const gr = ref.gpuDrawTimeMs?.p95Ms;
    out.push(
      `| ${a.case.resolution}² | ${a.case.quality} | ${a.case.material} | ${a.final.triangles.toLocaleString(
        'en-US',
      )} / ${ref.final.triangles.toLocaleString('en-US')} | ${fmt(ga, 2)} / ${fmt(gr, 2)} | ${
        ga && gr ? `${fmt(ga / gr, 2)}×` : 'n/a'
      } |`,
    );
  }
  out.push('');

  const pbr = group.filter((r) => r.case.material === 'pbr');
  if (pbr.length) {
    out.push(`### PBR cold start (×${ex})`);
    out.push('');
    out.push(
      'Map synthesis runs in a worker. Main-thread cost is applying the maps (packing, texture updates) plus the first PBR draw, which includes shader compilation and texture upload. In a fresh browser the first PBR draw compiles the program; later cases reuse it.',
    );
    out.push('');
    out.push(
      '| Field | Quality | Topology | Worker, off-thread (ms) | Main-thread apply (ms) | First PBR draw (ms) |',
    );
    out.push('|---|---|---|--:|--:|--:|');
    for (const r of pbr)
      out.push(
        `| ${r.case.resolution}² | ${r.case.quality} | ${r.case.reference} | ${fmt(r.final.pbrWorkerMs, 0)} | ${fmt(
          r.final.pbrPackCpuMs,
          1,
        )} | ${fmt(r.final.pbrFirstDrawCpuMs, 1)} |`,
      );
    out.push('');
  }
}

out.push('## Caveats');
out.push('');
for (const c of results[0].caveats) out.push(`- ${c}`);
out.push(
  '- RAF intervals are capped by the display refresh rate; on a 60 Hz panel ~16.7 ms is the floor, so GPU draw time is the better headroom signal.',
);
console.log(out.join('\n'));
process.exitCode = failures.length ? 2 : 0;
