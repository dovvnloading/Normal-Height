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

Dark graphite and restrained green-gray surfaces separate the graph, panels, and editable fields. A pale warm lime identifies active controls and primary actions. Generator, shaping, simulation, combination, and utility colors encode stage category, accompanied by text and icons. Inter handles interface text; IBM Plex Mono distinguishes seeds, dimensions, and numerical values. Fonts are bundled locally.

Numbers remain directly editable alongside sliders. The interface avoids fake controls, decorative data, and stock landscape imagery. Thumbnails and all previews are calculated from the graph.

## Graph principles

- Selection controls the inspector; preview selection is separate. An eye action previews any stage without rewiring the final output.
- Inputs and outputs have explicit labels. Invalid ports, duplicate target connections, and cycles are rejected or deliberately replaced with feedback.
- A failing graph preserves the last successful terrain and marks it as out of date.
- Dragging, multi-selection, grouping, annotations, duplication, minimap navigation, Fit, and Arrange are visible working affordances.
- Groups preserve child positions when moved or dissolved. Drag operations enter history as a single edit.
- Disconnected experimental nodes may remain in the graph. Only the selected output's ancestors are evaluated.

## Preview and export truthfulness

Working simulation resolution, rendered mesh resolution, and export resolution are different values. The UI reports them separately. The 3D mesh is capped at 512 samples per side; higher-resolution output remains available in 2D and export.

The 2D height display uses a fixed 0–1 elevation scale, explicitly labeled. The 16-bit PNG export remaps the actual minimum and maximum to use the full 16-bit range; its metadata supplies the inverse transform in meters. Normal exports use physical dimensions, never the viewport exaggeration.

Export evaluates the complete final-output graph at the requested resolution. It does not enlarge the preview. Project seeds and graph settings travel with the optional ZIP bundle.

## Deliberate boundaries

This implementation focuses on terrain authoring and transferable maps. It does not present itself as a calibrated geological simulator, a cloud project service, or an exact implementation of Terragen or Maxon's proprietary algorithms. Research and numerical choices are documented in [RESEARCH.md](RESEARCH.md).
