# Headless production CLI

Normal Height can validate projects, inspect the planned World evaluation, build tiled World archives, and verify delivered archives without opening a browser. These commands call the app's project parser, graph planner and World exporter. They do not maintain a separate terrain implementation.

## Install and run

Use a source checkout with Node.js 22.12 or later and install its locked dependencies:

```sh
npm ci
npm run nh -- --help
npm run nh -- validate terrain.nhterrain.json
npm run nh -- inspect terrain.nhterrain.json
```

For automation, invoke the launcher directly so npm's script banner does not precede the JSON result:

```sh
node scripts/nh.mjs validate terrain.nhterrain.json --json
node scripts/nh.mjs inspect terrain.nhterrain.json --json
```

The launcher resolves the source tree relative to its own location; input and output paths are resolved relative to your current working directory. It uses Vite's existing server-side module loader and does not require an additional TypeScript runtime. No HTTP listener or browser session is started.

`validate` parses the complete project, checks shared graph limits and port rules, requires a reachable Output, checks required inputs on the active branch, and checks World capability constraints. It does not allocate a terrain grid. Disconnected experiments are retained and do not need to be complete. `inspect` returns the same information, including required-input errors and native versus reconstructed stage descriptions, for tools that need to display build readiness. A project without any Output cannot produce an execution plan and fails either command.

## Build an archive

Output dimensions and destination are explicit:

```sh
node scripts/nh.mjs build terrain.nhterrain.json \
  --out builds/terrain-4k.zip \
  --samples 4096 \
  --format png16 \
  --maps normalGL,slope \
  --memory-mib 512 \
  --json
```

Rectangular native World graphs can use separate width and height sample counts:

```sh
node scripts/nh.mjs build rectangular-world.nhterrain.json \
  --out builds/region.zip \
  --samples 2048x1024 \
  --format raw32 \
  --tile-intervals 256 \
  --region 0,0,1024,512
```

`--region` uses the authored World's **interval coordinates**, in the same order as the World exporter: start X, start Z, width in intervals, depth in intervals. The manifest records the corresponding physical extent, origin and sample spacing in metres. Output dimensions count samples, not intervals.

Version 1 projects derive a World definition from their authored physical size and height scale. Version 2 projects retain their explicit World coordinates. The CLI selects the **CPU reference backend** and records it in the archive. It does not silently claim WebGPU execution. `--global-resolution N` explicitly changes the bounded whole-domain reference resolution; increasing output samples alone does not refine reconstructed erosion or other global solves.

### Maps and masks

Height is always included. Additional comma-separated `--maps` names are:

| Maps                                                               | Meaning                                                            |
| ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `flow`, `wear`, `deposition`                                       | Terrain diagnostics; ranges and units are recorded in the manifest |
| `normalGL`, `slope`                                                | Terrain geometry normals and physical slope                        |
| `basecolor`, `roughness`, `ao`, `orm`, `splat`, `curvature`        | World material maps                                                |
| `materialNormalGL`, `materialNormalDX`, `detailNormalGL`, `relief` | Material surface normals and relief                                |

Genesis-enabled projects additionally accept `hardness,lithology,uplift,incision,drainageArea,channel`.
These maps preserve physical values: Float32 little-endian RAW for continuous fields,
UInt8 RAW for categorical lithology IDs. Uplift/incision use metres and drainage area
uses square metres. They describe Genesis before optional World transport, and their
sampling modes, exact units, versioned settings and numerical report are recorded in
`manifest.genesis`. Requesting them without enabled Genesis fails preflight.
See [World Genesis](WORLD_GENESIS.md) for examples and decoding details.

Map availability and material constraints are validated by the same exporter as the UI. Request masks by the graph node ID, with a readable output name; repeat the option to include more than one:

```sh
node scripts/nh.mjs build terrain.nhterrain.json \
  --out builds/materials.zip \
  --samples 2048 \
  --maps basecolor,roughness,ao,orm,materialNormalGL \
  --mask rock-mask:Rock \
  --mask snow-mask:Snow
```

### Engine profiles

```sh
node scripts/nh.mjs build terrain.nhterrain.json \
  --out builds/unreal.zip --samples 1009 --profile unreal

node scripts/nh.mjs build terrain.nhterrain.json \
  --out builds/unity.zip --samples 1025 --profile unity
```

The Unreal profile accepts the existing supported landscape sample dimensions and 16-bit PNG or RAW. Unity uses power-of-two intervals plus one sample and defaults to little-endian RAW16. Profile sizing, tile rules, height transforms and import notes come from the shared exporter.

**These profiles retain the exporter's experimental import qualification.** Creating or verifying an archive does not prove a successful import in Unreal Editor or Unity. Read `importQualification` and `profileSettings` in the manifest; those statuses must be updated only after actual editor qualification.

## File integrity and cancellation

A build opens an exclusive temporary file beside its destination, streams chunks with awaited file writes, flushes and closes the file, and verifies the complete archive before publishing it. It does not retain the archive in JavaScript memory. Ordinary publication uses an atomic hard link that fails if the destination exists, including if another process creates it while the build runs. The temporary file is then removed.

Existing outputs are not overwritten by default. Use a new filename for a new revision, or explicitly request replacement:

```sh
node scripts/nh.mjs build terrain.nhterrain.json \
  --out builds/terrain.zip --samples 2048 --force
```

`--force` publishes through a same-directory atomic rename after verification. The input project cannot be used as the output path. Atomic publication requires filesystem support for same-directory hard links or rename; the CLI reports errors rather than falling back to a partial copy. Filesystem and operating-system guarantees still govern durability across power failure.

Ctrl+C and SIGTERM abort generation and remove an incomplete temporary output. A failed write, failed verification or rejected budget likewise leaves the destination unchanged. A forcibly killed process cannot run cleanup; an orphan file ending in `.partial` is not a completed delivery and can be removed after confirming that its process is no longer running.

## Verify a delivery

```sh
node scripts/nh.mjs verify builds/terrain.zip --json
node scripts/nh.mjs verify builds/terrain.zip --max-expanded-mib 512 --json
```

Verification reads the ZIP central directory before decompression, then streams each entry. It checks:

- Local and central headers, entry sizes, compression method and data descriptors agree.
- Paths are safe and unique; entries do not overlap or leave unreferenced archive data.
- Actual expanded bytes match each entry's declared size and CRC32.
- Tile file paths, sizes and CRC32 values agree exactly with the manifest.
- The archive contains precisely the listed tile/mask files plus its project, manifest and README.
- The embedded project parses successfully and agrees with the manifest's World definition and seed.
- Tile rows and columns cover the full sample grid with shared borders, without gaps or duplicate addresses.
- When present, Genesis provenance agrees with the project; field descriptors, units, formats and dimensions are valid, every selected map appears on every tile, continuous data is finite and lithology IDs are recognized.

No files are extracted to disk. ZIP64, multipart archives and encrypted entries are unsupported. Compressed input is limited to the existing archive profile below 2 GiB; expanded data is independently bounded by `--max-expanded-mib` (default 2048, capped below 2 GiB). Entries are capped at 64 MiB, the embedded project at 32 MiB, and the manifest at 16 MiB. Decompression stops if actual output exceeds its declaration, including archives that lie about their uncompressed size.

CRC32 detects accidental corruption; it is not a cryptographic authenticity signature. This verifier establishes delivery integrity and manifest consistency. It does not certify visual quality, geological calibration, seamless material appearance or engine-editor import success.

## Machine output and exit status

Successful `--json` calls emit one JSON object on stdout with `schemaVersion: 1`, `ok: true`, the command, source build provenance and the result. Failed calls emit `ok: false` and a structured error. Plain mode writes progress to stderr and a readable final JSON report to stdout, so output streams remain separable.

| Exit code | Meaning                                                                       |
| --------- | ----------------------------------------------------------------------------- |
| `0`       | Command completed successfully                                                |
| `1`       | Invalid project, failed capability/budget check, I/O error or invalid archive |
| `2`       | Invalid command or argument                                                   |
| `130`     | Cancelled by signal or abort request                                          |

The launcher reads Git revision and working-tree status using argument-based child-process calls. It reports `source: "unknown"`, `revision: "unknown"` and `dirty: null` when Git provenance is unavailable. An uncommitted tree is explicitly marked dirty. Neither a version label nor a clean exit replaces independent release qualification.

## Qualification coverage

`tests/cli.test.ts` exercises the public launcher, JSON output, provenance, rectangular streamed exports, output protection and explicit replacement, archive integrity, actual SIGINT cleanup, traversal rejection, corruption and adversarial decompression sizes. The dedicated CLI workflow runs these tests on the declared minimum Node version and Node 24. General terrain tests and production bundling remain in the main CI workflow.
