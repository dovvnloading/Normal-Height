# Actual application media

Repository screenshots and GIFs are captured from the production application,
with real generated heightfields, rendered materials, editor controls and
worker diagnostics. They are not generated marketing mockups.

| Asset                    | What it shows                                                                |
| ------------------------ | ---------------------------------------------------------------------------- |
| `studio-3d.png`          | Current Alpine terrain, graph and inspector, golden-hour lighting            |
| `studio-flow.png`        | The actual hydraulic flow diagnostic                                         |
| `landscape-tour.gif`     | Alpine watershed plus recent Studio ridgelands, wind dunes and impact fields |
| `compute-cache.png`      | A real repeated build with upstream cache reuse                              |
| `world-studio.png`       | Continuous world overview, shared tile grid and selected region              |
| `world-stage-report.png` | Regional preview with explicit global/native stage spacing                   |
| `world-export.png`       | Current tiled world package controls                                         |
| `world-workflow.gif`     | Overview → selection → refinement → diagnostic maps → stage report → export  |

`images/capture-provenance.json` records the exact source revision, UTC capture
time, browser version, viewport, rendering backend and landscapes. A software
capture is labeled ANGLE SwiftShader and must never be presented as hardware
WebGPU or performance evidence. Camera/material/light controls remain actual
app state. The landscape-tour caption identifies the current preset.

The software profile keeps the six full-quality screenshots, then uses the
app's **Balanced** mesh fidelity for the four landscape orbits. It captures
12 real frames per landscape at 5 fps; the hardware profile captures 28 at
10 fps. Both traverse the same camera arc, and the chosen fidelity, frame
count and cadence are recorded in provenance. The World walkthrough uses
eight full application frames at 1 fps in either profile.

## Regenerate locally

```bash
npm ci
npm run build
npm run preview -- --host 127.0.0.1 --port 4173 --strictPort
# In another terminal, with Chrome and Python Pillow installed:
node scripts/readme-media.mjs
```

For the reproducible software profile:

```bash
npx playwright install chromium
python -m pip install Pillow
NH_MEDIA_SOFTWARE=1 node scripts/readme-media.mjs
```

`NH_URL` chooses the preview origin. `NH_CHROMIUM_PATH` selects an explicitly
installed browser executable. The default profile uses installed Chrome with
the platform ANGLE backend; the software profile uses Playwright Chromium.

## Repository workflow

**World Engine correctness and live media** builds the source, runs unit and
browser acceptance, probes WebGPU/software fallback and captures the running
studio. Screenshots, GIFs, provenance and browser traces are uploaded as the
`world-engine-evidence` artifact. After successful same-repository acceptance,
the workflow commits the newly captured media to the implementation branch.
It never merges the PR or deploys the application. The media commit is made by the workflow token and does not create a recursive
chain of capture runs.

The job uses a normal fast-forward push. If another author advances the branch
during capture, that push fails safely; the artifact still contains the
captures for inspection. A new source run can regenerate current media.
