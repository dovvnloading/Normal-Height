# Workspace design

## Product intent

Normal Height is a working terrain instrument: construct a graph, inspect its scalar fields, run actual sediment transport, and export precise data. The landscape is the main visual element. The interface should remain quiet enough to let landform changes be obvious.

The initial project deliberately places hydraulic erosion in the inspector and loads a complete five-stage Alpine watershed graph. A user can change rainfall or erosion rate and export without first assembling a pipeline. Every starting landscape is editable.

## Spatial hierarchy

1. A compact project bar contains project identity, undo/redo, portable file operations, and export.
2. A thin working toolbar makes actual simulation resolution and automatic generation visible.
3. The center gives about two thirds of its height to the terrain and one third to the graph. The divider is draggable and keyboard accessible.
4. The left library organizes generators, shaping operations, erosion, combinations, and utilities. Noise families are directly searchable. A separate landscape tab supplies complete graphs.
5. The right inspector explains the selected node, then groups controls by their visible effect. Advanced settings are collapsed initially.
6. A persistent status bar reports the stage, resolution, connections, and generation time.

Panels collapse independently. On smaller displays they become overlays rather than shrinking the working canvas to nothing. A large display and pointer are recommended for intensive graph editing.

## Visual language

**Stone-gray is the dominant interface color**, not forest green: the project bar and inspector use warm white-gray surfaces, the graph canvas uses a deeper drafting gray, and node cards read as pale paper against it. Charcoal type and subdued borders keep dense numeric controls legible. Muted sage identifies focus, selected objects, and terrain-related actions; clay, dusty ochre, slate-teal, and soft plum distinguish other node categories without coloring entire panels. The scene background is neutral gray so the terrain remains the hero. Text and icons always accompany color coding. The palette uses light browser chrome and preserves contrast for small labels, inputs, and selected states. Inter handles interface text; IBM Plex Mono distinguishes seeds, dimensions, and numerical values. Fonts are bundled locally.

Palette reference: stone canvas `#e4e7e3`, paper panels `#f5f5f2`, charcoal text `#303935`, sage action `#667e5f`, and warm clay `#986f56`. Color choices affect only the interface and renderer's backdrop, never actual height samples or export data.

Numbers remain directly editable alongside sliders. The interface avoids fake controls, decorative data, and stock landscape imagery. Thumbnails and all previews are calculated from the graph.

### Light and dark appearance

The default visual language has **two coordinated modes**: the pale stone drafting room and a neutral charcoal workspace. The dark mode keeps muted botanical, ochre and slate accent cues but uses graphite-gray surfaces instead of a dark-green wash. A keyboard-accessible sun/moon header control switches modes, and the choice is stored locally. With no explicit choice, the application follows the system's color-scheme preference (including changes while it is open). Mode changes adjust the graph grid, dialogs, native controls and 3D preview background without regenerating terrain or changing height exports.

The base CSS defines layout and light colors. The separate `theme-dark.css` file contains dark-only color declarations scoped to `[data-theme="dark"]`, so graph tools and inspector elements share geometry across both appearances.

## Graph principles

- Selection controls the inspector; preview selection is separate. An eye action previews any stage without rewiring the final output.
- Inputs and outputs have explicit labels. Invalid ports, duplicate target connections, and cycles are rejected or deliberately replaced with feedback.
- A failing graph preserves the last successful terrain and marks it as out of date.
- Dragging, multi-selection, grouping, annotations, duplication, minimap navigation, Fit, and Arrange are visible working affordances.
- Groups preserve child positions when moved or dissolved. Drag operations enter history as a single edit.
- Disconnected experimental nodes may remain in the graph. Only the selected output's ancestors are evaluated.

## River / ridge authoring

Spline nodes store normalized map coordinates as project data; the same data drives editor handles, the Catmull–Rom path, the 3D guide, and worker-side height modification. The editor inserts a spline before the first connected hydraulic stage when possible; the graph and editable points remain non-destructive. Selecting the path does not imply a new project version.

2D point dragging is a temporary local interaction until release, committed as one undo step. Click inserts near the closest control span; reverse changes the river's headwater/outlet interpretation, and exact coordinates remain available in the inspector. The active curve is drawn above terrain color but is never baked into exported imagery.

The shape operation evaluates a nearest-segment distance field in a limited-radius raster window. River incision uses smooth banks and optional strictly descending bed elevations; ridge mode adds a single smooth crest without overlapping brush artifacts. The numerical data flows into downstream erosion and normal/height exports. Terrain sample counts and project storage are independent of screen scale.

## Preview and export truthfulness

Working simulation resolution, rendered mesh resolution, and export resolution are different values. The UI reports them separately. The 3D mesh is camera-adaptive with bounded budgets independent of source grid and export grid size. Source-derived normals preserve lighting fidelity between levels of detail; rendered triangles never imply additional erosion data beyond the underlying Float32 field. View-only inspection and comparison use that authoritative field, not the display mesh.

The 2D height display uses a fixed 0–1 elevation scale, explicitly labeled. The 16-bit PNG export remaps the actual minimum and maximum to use the full 16-bit range; its metadata supplies the inverse transform in meters. Normal exports use physical dimensions, never the viewport exaggeration.

Export evaluates the complete final-output graph at the requested resolution. It does not enlarge the preview. Project seeds and graph settings travel with the optional ZIP bundle.

## Deliberate boundaries

This implementation focuses on terrain authoring and transferable maps. It does not present itself as a calibrated geological simulator, a cloud project service, or an exact implementation of Terragen or Maxon's proprietary algorithms. Research and numerical choices are documented in [RESEARCH.md](RESEARCH.md).
