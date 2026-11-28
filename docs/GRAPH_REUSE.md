# Reusing graph selections

The node graph supports portable selections across projects. Select nodes, then use **Copy selected graph** / **Paste graph**, or **Export selected graph** / **Import graph** in the graph toolbar. The file workflow produces a `.nhgraph.json` document and works without clipboard permissions.

While focus is in the graph, **Ctrl/Cmd+C** copies and **Ctrl/Cmd+V** pastes. Editing a note or an input keeps the normal text shortcuts. Clipboard access is requested only by the button or keyboard action; a denied or unavailable clipboard gives a file-workflow alternative.

## What a selection contains

- Selecting a group includes all its descendants, including nested groups, notes, imported heightmaps, and spline paths. Selecting a child on its own detaches it from an unselected group while preserving its position relative to other selected nodes.
- Connections are included only when both endpoints belong to the selection. Connections from outside the selection are intentionally omitted. Reconnect any required inputs in the destination graph.
- Node parameters, labels, bypass states, dimensions, group hierarchy, raster payloads, spline data, and internal port connections are retained. Insertion assigns fresh node and edge identifiers and places the selection near the center of the current graph view.
- The destination keeps its own seed, physical scale, World settings, materials, paint, and output graph. A selection is reusable graph content, not a complete project snapshot. Nodes depending on project context can therefore produce different terrain in another document. Use `.nhterrain.json` when the complete project context must travel with the graph.

An accepted paste or file import is **one undo operation**. It selects the inserted content and frames it in the graph. Importing a selection does not automatically connect it to the destination output or switch the active output.

## Admission and error behavior

The importer validates the snippet before constructing a candidate document, then checks the combined document before applying it. Validation covers node kinds and identifiers, ports, duplicate inputs, graph cycles, group ancestry, spline data, raster payloads, and the shared project format rules.

The combined graph must stay within **128 nodes** and **512 edges**. Imported raster data must fit the existing **16 MiB raster budget**, and the complete destination project must remain serializable within the **32 MiB project file limit**. Snippet files and clipboard text have the same 32 MiB input limit. An unsupported format, invalid graph, exceeded budget, unavailable clipboard, or document change while an asynchronous read is pending leaves the current project unchanged.

The portable schema is an explicit versioned envelope:

```json
{
  "type": "normal-height-graph",
  "version": 1,
  "name": "Selection name",
  "graph": { "nodes": [], "edges": [] }
}
```

This example shows the shape only; an import requires at least one valid node. Ordinary project JSON is not silently interpreted as a snippet.

## Qualification

`tests/graph-clipboard.test.ts` exercises group closure, detached children, exact spline and raster preservation, portable serialization, fresh identifiers, internal connections, destination context preservation, malformed inputs, size limits, combined node and raster budgets, and full-project storage admission. It also checks the graph cards' Noise Studio v3 and hydraulic model summaries.

`tests/e2e/graph-reuse.spec.ts` drives the production UI to export a selected group, import the downloaded selection into another project, verify the resulting hierarchy and edges, undo and redo the whole insertion, and reject malformed and over-capacity imports without changing the destination. Clipboard permission behavior remains browser-controlled; the automated cross-project workflow uses the portable file path so it is independent of permission prompts.

This feature provides reusable selections. It does not add parameterized graph macros, a semantic asset package system, external asset references, or automatic dependency connections.
