# Terrain icons

Normal Height uses 31 custom transparent terrain icons, shared by the node library, graph, map selector, export dialog, presets, and header.

- **Runtime sprite:** `public/icons/terrain-icons-atlas.webp` — 4 columns × 8 rows, cells 128 × 80 px.
- **Component and mappings:** `src/components/TerrainIcon.tsx`.
- **Styles:** `src/components/TerrainIcon.css`.
- **Usage:** `<TerrainIcon name="hydraulic-erosion" height={18} />`.
- **Accessibility:** decorative beside text; pass `label` when used alone.
- **Asset location:** the URL honors `import.meta.env.BASE_URL` for GitHub Pages.
- **Generic UI actions:** keep Lucide (Undo, Redo, Search, Zoom, Close, etc.).

The separately supplied production asset pack contains individually cropped transparent PNGs for all 31 icons.

## Atlas order (row-major)

1. normal-height-logo
2. mountain-range
3. procedural-noise
4. domain-warp
5. river-ridge-spline
6. hydraulic-erosion
7. thermal-weathering
8. terrace
9. height-remap
10. blend
11. height-slope-mask
12. terrain-output
13. heightmap
14. shaded-relief
15. normal-map
16. slope-map
17. water-flow-map
18. erosion-map
19. deposition-map
20. pbr-base-color
21. roughness-map
22. ambient-occlusion
23. material-weights
24. curvature-map
25. packed-orm
26. alpine-watershed
27. granite-massif
28. desert-badlands
29. volcanic-caldera
30. folded-highlands
31. river-cut-highlands
