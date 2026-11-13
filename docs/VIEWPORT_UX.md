# Viewport UX: terrain exploration and analysis

The viewport is a view-only instrument over the authoritative Float32 terrain.
Navigation, materials, overlays, measurements and comparisons do **not** modify
heightfield samples, rerun erosion, or change project exports.

## Navigate

- Choose **3D**, **2D**, **Split** or **Compare** along the top.
- **Focus** temporarily removes the library, graph and inspector without destroying
  your WebGL renderer. Use the button again or press **F** while a preview element
  has focus to return to editing.
- Split has a draggable divider. Arrow keys change it in 5% increments, Home
  restores 50/50. At narrow widths the panes stack vertically.
- In 3D, orbit with left drag, pan with right drag, double-click to focus an
  actual terrain surface point, and scroll to zoom. The compass points in the
  actual camera direction and clicking it faces north. The camera menu
  provides N/E/S/W and up to eight saved camera bookmarks.
- In 2D, wheel zoom is anchored at the cursor, drag pans, Home fits, +/- zoom,
  and a two-finger gesture supports pinch. Your map zoom/pan is retained across
  2D/3D mode switches and stored separately from the terrain project.
- The **Map overlays** menu composites one optional diagnostic field
  (slope/flow/wear/deposition/normals) at user-controlled opacity.

## Inspect, measure, profile

The shared toolbar has Navigate, Inspect, Measure and Profile.

1. **Inspect:** click either the 2D source map or the 3D terrain to pin a
   location. The same normalized (u,v) coordinate is highlighted in the other
   view. Hover provides an ephemeral marker. The readout shows tile-relative
   easting/northing, elevation in meters, physical slope and flow.
2. **Measure:** click A then B. The readout shows horizontal distance,
   elevation change, grade and sampled surface distance.
3. **Profile:** click A then B to additionally plot source elevation along the
   transect. Select a third point to start a new transect. Clear pins with X.

For non-pointer inspection, focus the **2D canvas**, use the arrow keys to move
an inspection cursor (Shift moves 5% instead of 1%), then press Enter/Space
to pin the active point.

Coordinates are dimensionless in storage; physical quantities come from the
current project's worldSize and heightScale. The measured profile samples the
original height grid bilinearly at 97 locations, not the camera-adaptive
rendering mesh or micro-normal shading. Surface distance is sampled along a
straight horizontal transect; it is not a routed shortest path.

## Compare terrain stages and iterations

1. Wait for a completed, up-to-date terrain preview.
2. Choose **Pin baseline**. This retains one immutable, in-memory
   HeightField and its project dimensions; no buffers are detached.
3. Change an upstream node and regenerate. Or preview an intermediate node,
   pin it, and **Return to Terrain output**.
4. Choose **Compare**. The wipe uses two colorized source fields at the
   same normalized coordinates. The slider reveals earlier/current terrain.
5. Select **Elevation change** for a signed meter difference.
   Warm regions are lower than baseline, cool regions are higher.
   The scale is computed from the actual largest absolute delta.
6. Clear or replace the baseline when finished.

Comparisons require the same physical tile width. Different source grid
resolutions are handled using bilinear sampling. The difference image is
downsampled to a maximum of 512² *for display only* and computed in a
separate worker using copies of the source height buffers; the measurements
and exports remain high precision. One pinned comparison field at 1024² may
retain roughly 16 MiB across four Float32 channels.

## State, resilience, and limits

- Saved camera bookmarks, map framing and split ratio live in browser local
  storage. They are view preferences and are not written into .nhterrain.json.
- PBR channel changes blank the previous channel raster while the material
  worker generates the new map, with explicit updating/error feedback. This
  avoids labeling obsolete pixels as the new channel.
- WebGL failures retain 2D mode and a retry option. A scene rebuild leaves
  the graph, source data and export workflow intact.
- The 3D top view currently uses the perspective camera; it is not an
  orthographic survey projection. The pinned baseline workflow compares
  2D map and elevation fields, not simultaneous dual-WebGL cameras.

## Verification

- Unit tests: `src/model/viewportUX.test.ts`, `src/model/compare.test.ts`
- Desktop browser QA: `tests/e2e/viewport-ux.spec.ts`
- GitHub workflow: `.github/workflows/viewport-ux-qa.yml`
- Build: `npm run build`; full unit suite: `npm test`

The visual QA workflow uses Chromium and software WebGL in CI; actual touch
hardware, integrated GPUs and low-memory devices should be checked before
performance claims are generalized. Rendering performance targets remain in
`docs/MESH_PERFORMANCE.md`.
