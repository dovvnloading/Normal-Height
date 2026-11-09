# Normal Height

**A procedural terrain studio for shaping mountain ranges, simulating erosion, and exporting precise heightmaps.**

Normal Height is a React and TypeScript web application. Its visual node graph drives a real Float32 terrain pipeline, evaluated in a dedicated Web Worker. Three.js renders the displaced terrain; a separate 2D view inspects height, normals, slope, flow, wear, and deposition.

![Normal Height studio showing the Alpine watershed, node graph, and hydraulic erosion controls](docs/images/studio-3d.png)

_The running production app, captured in Chromium with the editable Alpine watershed graph at 512 × 512._

## Run the application

Use Node.js 22.12 or newer (Node 24 is used in CI).

```bash
npm ci
npm run dev
```

Open the URL printed by Vite. All terrain generation and project storage happen in the browser. No API keys, account, database, or backend service are required.

```bash
npm run build       # Typecheck and generate dist/
npm run preview     # Serve the production build
npm test            # Engine, export, and rendering-math tests
npm run test:e2e     # Build and verify the production app in Chromium
```

For the browser tests, run `npx playwright install chromium` once. CI installs its browser dependencies automatically and uploads screenshots, traces, and the production app as build artifacts.

## What the studio does

### Terrain construction

- **Mountain range generator:** direction, width, relief, sharpness, fractal detail, and distortion. Profiles include connected alpine ranges, broad massifs, volcanic calderas, and badlands.
- **Twelve procedural noise families:** Perlin, simplex, fractal Brownian motion, ridged multifractal, billow, turbulence, Voronoi F1, Voronoi ridges, cellular, wave, warped turbulence, and an independently designed Naki-inspired pattern.
- **Shaping nodes:** domain warp, terrace, and height remap.
- **Combination nodes:** blend fields with mix/add/multiply/min/max operations and optional masks; height and slope masks can also limit hydraulic erosion.
- **Reproducible seeds:** a project seed plus per-node offsets. Changing node positions or selection does not change the generated terrain.
- **Six editable landscape graphs:** Alpine watershed, Granite massif, Desert badlands, Volcanic caldera, Folded highlands, and the spline-enabled River-cut highlands.

### River and ridge designer (Normal Height 1.1)

- Add **River / ridge spline** from **Shape & transform**. The app inserts it before the first hydraulic-erosion stage (or terrain output) when a height connection is available, then opens the 2D editor.
- In the **2D map**, drag numbered control points to reshape the Catmull–Rom curve. Click empty map space to insert near the closest segment; double-click a control point to remove it (at least two points remain). Use the inspector to edit exact X/Y percentages, reverse flow direction, add points, or reset the route.
- Switch **Path operation** between **Carve river and valley** and **Raise mountain ridge**. Change core width, relief and bank/flank spread to adjust the actual geometry. River mode never deposits material, and **Keep river bed downhill** creates a continuous descending bed from point 1 (headwater) to the last point (outlet).
- Switch to **3D terrain** to inspect the sculpted relief and selected spline guide. The terrain is generated as real Float32 samples and continues through subsequent erosion/weathering nodes. The curve is saved non-destructively in portable project files and reevaluated for 16-bit/RAW exports.
- For easier editing, zoom and pan the map; in edit mode, middle/right-drag pans and the wheel zooms. Use **Finish editing** to return to map inspection.

Paths contain 2–24 tile-normalized control points. At high export resolutions, the spline is rasterized using the closest curve segment per pixel rather than accumulating brush stamps, preventing control-point mounds. The river-bed grade is an artistic constraint, not a globally solved hydrological drainage network; automated basin routing, groundwater and GPU fluid solvers remain future work.

### Actual erosion

Hydraulic erosion uses seeded droplets with downhill gradient sampling, inertia, gravity, carrying capacity, brush erosion, deposition, evaporation, and bounded flow length. Removed material is transported and deposited; it is not a visual noise overlay. Multi-scale mode runs wider, longer-lived parcels before finer rills on the requested grid.

Thermal weathering conservatively redistributes material from over-steep slopes to form softer talus transitions. Flow, erosion wear, and deposition are available as diagnostic maps and as graph inputs.

The solver is an artistic particle model, not a calibrated watershed or geological-time simulation. The research notes distinguish this implementation from Terragen's documented workflow and from more expensive grid-fluid solvers.

### Graph authoring

- Add, connect, reconnect, rename, bypass, duplicate, and delete nodes.
- Explicitly preview an intermediate node without altering the final output.
- Multi-select, group/ungroup, resize groups, and add editable notes.
- Fit, Arrange, zoom, pan, and use a minimap.
- Undo/redo project edits, including graph changes and landscape switches.
- Reject cycles and invalid connections while preserving the last valid preview.

### Preview

- **3D:** real displaced geometry, computed normals, cast shadows, alpine/clay/elevation materials, sun controls, contours, wireframe, orbit controls, and image capture.
- **2D:** height, shaded terrain, OpenGL normals, physical slope, flow, wear, and deposition, with pan/zoom and pixel/elevation inspection.
- **Split view:** inspect the surface and map together.
- The 3D display mesh is capped at 512 × 512 vertices. Working simulation grids reach 1024 × 1024 and export grids reach 2048 × 2048. High-resolution exports rerun the entire connected graph.
- Cancellation terminates the active worker. The previous successful terrain stays visible while the next one builds.

![The Water flow map calculated by the hydraulic erosion simulation](docs/images/studio-flow.png)

### Files

| Output                       | Encoding and meaning                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| Heightmap PNG                | True 16-bit grayscale; actual height minimum/maximum mapped to 0–65535                    |
| Elevation RAW                | Headerless, little-endian Float32 elevations in meters                                    |
| Normal PNG                   | 8-bit RGB OpenGL tangent-space +Y normals, based on physical dimensions                   |
| Flow / wear / deposition PNG | 8-bit display visualizations; not physical flow-rate measurements                         |
| Project                      | Versioned `.nhterrain.json`, containing graph, parameters, seeds, and physical dimensions |
| ZIP bundle                   | Map, metadata, and reproducible project file                                              |

The 16-bit metadata includes the exact elevation reconstruction formula, min/max, world extent, sample spacing, and orientation. PNG samples are big endian as required by the format. The first image row is north (negative Z in the 3D scene); X increases to the right/east.

Projects autosave locally in the browser. Use **Save project** to keep a portable copy, and **Open project** to restore it. Imports validate version, dimensions, node types, parameter bounds, identifiers, group relationships, and ports before replacing the current graph.

## Appearance

Use the **moon / sun icon in the project header** to switch between the light stone-gray and dark charcoal-gray interfaces. Both use neutral surfaces with muted sage, clay, and slate accents. On first visit the studio follows your device's light/dark preference; clicking the icon saves your choice in this browser (`normal-height.theme.v1`) and overrides the device setting. Your terrain graph, simulation, autosave, and exported files are identical in both themes. The WebGL preview updates its backdrop without rebuilding the heightfield.

## A quick workflow

1. Open **Alpine watershed** and wait for the first terrain to finish.
2. Select **Carve the watershed**. Change rainfall, erosion rate, or sediment capacity.
3. Choose **2D map → Water flow** to inspect the drainage network, or use **Split**.
4. Use the eye on **Alpine spine** to compare the uneroded source. Return to Terrain output when finished.
5. Open **Scene** to set tile width and elevation scale. Viewport exaggeration changes the display only.
6. Export a **16-bit PNG** at the desired grid size, with the metadata bundle enabled.

## Architecture

```text
src/model/        Project types, node definitions, editable presets, file validation
src/engine/       Seeded noise, graph evaluator, hydraulic/thermal solvers, worker
src/components/   Application panels, React Flow graph, 2D/3D viewport, export dialog
src/render/       Three.js terrain scene, physical normals, diagnostic color mapping
src/export/       16-bit PNG encoder, Float32 RAW encoder, ZIP metadata
src/hooks/        Worker lifecycle, debounced evaluation, cancellation, stale state
tests/           Numerical, encoding, and browser workflow verification
```

The graph evaluator follows dependencies from the previewed node or final output, memoizes each reachable node, and reports node timings and thumbnails. Height arrays are immutable across node boundaries. Worker results use transferable buffers. A conservative memory preflight bounds high-resolution graphs before expensive allocations.

## Hosting — GitHub Pages

The public app is deployed from the `main` branch through [the GitHub Pages workflow](.github/workflows/deploy-pages.yml). After Pages is enabled, the site URL is **https://dovvnloading.github.io/Normal-Height/**.

**One-time repository setup:** On GitHub, open **Settings → Pages → Build and deployment → Source**, choose **GitHub Actions**, and save. The workflow deploys the Vite production build to GitHub Pages on each push to `main`. If the latest deployment was triggered before Pages was enabled, run the **Deploy Normal Height to GitHub Pages** workflow manually from the **Actions** tab.

The production build is a client-side webapp in `dist/`. It must be served over HTTP(S); Web Workers cannot be reliably loaded from `file://`. Vite's relative asset base supports subdirectory hosting. Project state stays in the visitor's browser unless they explicitly download it. GitHub Pages requires no server, API keys, or database for this application.

