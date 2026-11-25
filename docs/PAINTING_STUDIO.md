# Painting studio

The painting studio is a material authoring workspace inside the terrain viewport. Open it with **Paint** or **B** after terrain is available. Painting changes the complete material response: substrate coverage, base color, roughness, relief and normals. It does not sculpt the heightfield or rerun erosion.

## Getting started

Choose **Rock**, **Soil**, **Vegetation** or **Snow** from the swatches, then drag on either the 3D terrain or 2D map. Both views use the same tile coordinates and project history. The studio keeps essential controls above the canvas and puts detailed tools into **Materials**, **Brush** and **Layers** tabs. Use **Tools** to open or close the inspector. On narrow screens it becomes a drawer, preserving space for the canvas.

Entering Paint focuses the viewport while retaining the graph and inspector state; leaving Paint restores the previous layout. **Focus viewport** can also be toggled manually. Switching between 2D, 3D and Split preserves the brush settings. Viewing a diagnostic channel does not require leaving Paint. If terrain is rebuilding, a layer is locked or hidden, or Original is being displayed, the studio explains why painting is paused.

### Brush controls

| Control | Behavior |
| --- | --- |
| Radius | Size of the brush footprint. Meters use physical terrain dimensions; texels use the working grid; screen pixels keep a useful visible size while zooming. |
| Strength | Coverage contributed by one gesture, independent of pointer event frequency. Separate gestures can build up coverage. |
| Hardness | Size of the full-strength inner area. The outer area fades smoothly to zero. |
| Pen pressure | Off, radius, strength, or both. Real stylus pressure is recorded with the path. Mouse and touch input retain full pressure. |
| Stroke smoothing | Stabilizes jitter while retaining the release endpoint. |
| Brush texture | Smooth coverage, natural grain, or scattered patches. Texture uses a stored seed so reopening and export reproduce the stroke. |
| Brush spacing | Spacing of textured brush stamps. |
| Tip aspect and angle | Shape and direction of the elliptical footprint. |
| Position jitter | Seeded variation in textured stroke placement. |
| Mirror painting | Paint across east/west, north/south, or both axes. Mirrored paths are stored with the same gesture and undo together. |
| Cursor and preview | Adjust the immediate stroke overlay, hardness ring and terrain-rule visualization. |

Presets include **Soft wash**, **Hard round**, **Rock outcrop**, **Earth & sediment**, **Meadow scatter**, **Snow drift**, **Blend edges** and **Restore terrain**. They configure the brush while preserving its current radius. Rock, meadow and snow presets include terrain rules; clear those rules when unconstrained painting is desired.

**My brushes** saves named presets for reuse; up to 24 custom presets can be kept in this browser. A custom preset includes brush controls and terrain rules, and excludes the current project selection.

Brush preferences are saved in this browser independently of terrain projects. Transient selections are not restored into an unrelated project. Strokes retain the settings used to create them, so changing the current brush does not rewrite earlier strokes.

## Navigation and keyboard use

| Action | Input |
| --- | --- |
| Open Paint | **B** |
| Toggle eraser / previous substrate | **E** |
| Rock / Soil / Vegetation / Snow | **1 / 2 / 3 / 4** |
| Smaller / larger radius | **[ / ]** |
| Softer / harder edge | **Shift + [ / ]** |
| Temporarily navigate | Hold **Space** and drag; release Space to resume painting |
| Pan / zoom between strokes | **Right-drag / wheel** |
| Sample a substrate | **Alt-click**, or the material sampler button |
| Temporarily blend nearby materials | Hold **Shift** when starting a stroke |
| Cancel an uncommitted stroke | **Escape**; undo shortcuts also cancel an active draft first |
| Leave Paint when no stroke or area action is active | **Escape** |
| Undo / redo | **Ctrl/⌘ Z / Ctrl/⌘ Shift Z** |
| Move the 2D brush cursor / dab | **Arrow keys / Enter** |
| Fit the 2D map | **Home** |

Typing in number fields, layer names or other editors does not trigger painting shortcuts. Enter commits a numeric edit; Escape restores its previous value. Space is reserved for temporary navigation in Paint; Enter is the keyboard dab action.

One finger paints. Adding a second finger cancels the uncommitted stroke and hands the gesture to pan/zoom. All fingers must lift before a new paint gesture begins. While a pen is drawing, touch contacts are ignored as palms. Browser and device support for pressure varies; choose a pressure mode in the Brush panel to use the values the device supplies.

## Authored paint layers

**Paint layers** are editable groups of authored strokes. The four **substrates** are material definitions. A single paint layer can contain strokes of several substrates.

The top visible paint layer covers the layers below it. Add and rename layers to organize work, then use visibility and opacity to compare alternatives. Lock a layer to prevent accidental painting or changes to its contents. Duplicate a layer to try a variant; reorder it to change which materials cover others. Delete a layer or individual recent strokes from the history, then use Undo to restore them if needed.

Opacity applies once to the completed layer. It is not multiplied into each stroke separately. Erasing reduces coverage inside the active layer, revealing lower paint layers before the procedural surface. Hidden and zero-opacity layers remain in the project and export as editable authoring data; they do not contribute to the rendered material.

**Painted / Original** temporarily displays the procedural material with authored layers omitted. It does not remove strokes, create history entries or modify the saved project. Return to Painted to continue editing.

**Global color** changes a substrate definition everywhere: procedural coverage, every paint layer and existing strokes. For local changes to coverage, use a separate paint layer and its opacity or terrain rules.

## Terrain rules and area editing

Rules combine: a point must satisfy every enabled rule to receive paint. **Next strokes** attaches the rules to new strokes. **Entire layer** applies a mask to all existing and future strokes in the selected layer.

| Rule | Units and meaning |
| --- | --- |
| Elevation | Physical meters, independent of display exaggeration. |
| Slope | Degrees: 0° is flat and 90° is vertical. |
| Water flow | Normalized terrain runoff field. |
| Curvature | Signed landform measure. Negative values select ridges; positive values select valleys. |
| Facing direction | Compass degrees. A range such as 315°–45° wraps across north. |
| Mask feather | Softens the boundaries of the enabled ranges. |
| Natural breakup | Adds deterministic coherent variation to coverage. Breakup scale is measured in meters. |

The rule overlay helps locate eligible terrain. It is a viewing aid and is not part of exported material textures.

**Polygon select** collects points on the terrain. Use Apply or Enter after at least three points to close the polygon. The selection clips subsequent strokes, fills and replacement. **Invert** selects its complement, and **Clear** removes the restriction.

**Connected fill** waits for a terrain click, finds the connected region with similar material weights, and fills that region with the chosen substrate. The region is stored as compact row runs so it survives project reopening. **Fill selection** covers the current selection. **Replace source material** replaces the chosen source with the active substrate, respecting the selection and terrain rules. Each fill or replacement is one undoable project action.

## Live feedback and final quality

The cursor shows the outer footprint and optional inner hardness ring. The immediate coverage overlay responds before the worker finishes. The live worker then evaluates actual PBR material coverage and surface response during the drag. It uses a grid capped at **192 × 192 samples** to bound interaction work. Long drags update as worker results arrive; there is no fixed frame-rate guarantee.

On release, the gesture is committed once and the final material is generated at the current working resolution. Each visible viewport keeps its own feedback until its completed result arrives; changes to material settings invalidate older previews. The material status reports preparation, live painting and refinement. Escape cancels the draft and restores the completed material without adding history.

A small live grid cannot resolve all features visible in a higher-resolution final bake. Close-up procedural shading is also distinct from exported texture resolution; see [Material synthesis](MATERIALS.md#material-synthesis) and [Live 3D near-field surface detail](MATERIALS.md#live-3d-near-field-surface-detail-display-only).

## Saving, exporting and capacity

Project saves include the paint layer stack, stroke paths, pressure, material choices, brush parameters, terrain rules and per-stroke selections. Older projects containing only `materialPaint` remain readable and appear as **Base paint**. Editing layer properties upgrades the authoring data to `paintLayers`; the terrain schema remains compatible with the existing graph and world settings.

The limits are **64 paint layers**, **4,096 stroke records** and **128,000 path points** per project. A stroke record contains at most **2,048 points**; very long gestures may be divided into records while still using one undo action. Paths are simplified with a small spatial and pressure error budget before committing. Mirrored paths count toward capacity. Polygon selections support up to **256 points**; connected regions use a bounded selection grid.

The Layers panel shows capacity and warns as it fills. A long gesture also warns when its sampled points approach the remaining capacity, including mirrored paths; final path simplification may reduce that estimate. If a gesture exceeds the project limit, it is rejected as a whole rather than partially saved. Remove unused strokes or layers, or undo previous work, before continuing. Autosave uses local storage for ordinary projects and an IndexedDB backup for larger layered projects. Restore last session chooses the newest available saved revision. Both stores are local to the browser, so download project copies during substantial work or before clearing browser data.

**Export maps → Complete PBR material set** regenerates the selected terrain grid and replays the authored layers. Hidden layers remain editable in the bundled project but do not affect baked maps. PNG color-space and normal conventions are documented in [Maps in a PBR ZIP](MATERIALS.md#maps-in-a-pbr-zip).

## Verification

The targeted browser suite is `tests/e2e/painting-studio.spec.ts`. It exercises layer compositing and locks, numeric and preset persistence, scoped keyboard shortcuts, Space navigation, two-finger handoff, polygon and connected fills, live PBR drafts, undo/redo, project saves, PBR export roundtrips, and restoring a painted project when localStorage writes exceed quota. It also verifies that importing an unrelated file clears transient polygon selection. Pure input tests cover coalesced path samples, stylus endpoints, pressure-preserving simplification and symmetry; paint-engine tests cover masks, layer compositing and backward-compatible project parsing.

Run after installing dependencies:

```sh
npm test
npm run build
npx playwright test tests/e2e/painting-studio.spec.ts
```
