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
app's **Balanced** mesh fidelity and neutral studio lighting for the landscape
tour. It captures four real cardinal camera views per landscape at 1 fps,
through the app's camera bookmarks. This avoids the extra software renders
needed for a damped camera orbit. The hardware profile captures 28 orbit frames
at 10 fps with golden-hour lighting. The chosen fidelity, lighting, camera
mode, frame count and cadence are recorded in provenance. The World walkthrough
uses eight full application frames at 1 fps in either profile.

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

**World Engine correctness** builds the pinned pull-request commit, runs unit
and browser acceptance, and probes WebGPU/software fallback. Numerical reports
and browser traces are uploaded as the `world-engine-evidence` artifact. This
workflow has read-only repository permission, keeps no checkout credentials,
and never commits generated files. Rerunning it verifies the same revision
without moving the branch or regenerating media.

**World Studio media (manual)** captures the production application at the
revision selected when the workflow is dispatched. It first passes unit,
build and World browser acceptance. Screenshots, GIFs and their exact source
provenance are uploaded as `world-studio-media-<source revision>`; browser
acceptance evidence has a separate artifact. Its default is artifact-only.

To update committed media, explicitly enable **publish** on that manual run.
A separate publication job receives write permission and downloads only that
run's verified media. It refuses to publish if the selected branch has changed,
uses a normal fast-forward push, and leaves captures available as artifacts
on failure. Concurrent captures for a branch are serialized. If all visuals
are unchanged, it retains their original provenance rather than creating a
commit solely for a new capture timestamp or source revision.

A published media commit uses `GITHUB_TOKEN`. GitHub creates approval-required
CI runs for pull-request updates made with that token; a collaborator with
write access must select **Approve workflows to run** on the PR. This is
[GitHub's documented behavior](https://docs.github.com/en/actions/concepts/security/github_token#when-github_token-triggers-workflow-runs).
The approved correctness run cannot publish another media commit, so acceptance
can finish on a stable HEAD. Neither workflow merges the PR or deploys the app.
