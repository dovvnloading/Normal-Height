# Verification record

Verified on 9 November 2026 against application commit `96a625c547b6b39ebec78000738c321731e8becf`. The screenshots in this directory are captures of the running production app; no terrain or interface elements were composited into them.

## Production build and automated checks

[GitHub Actions run](https://github.com/dovvnloading/Normal-Height/actions/runs/42673721339) completed successfully. It installed the locked dependencies, passed TypeScript and the production Vite build, ran 28 numerical/file/rendering tests, and passed all six Chromium workflow scenarios.

The browser tests build the application and serve `dist/`, exercising its bundled worker and assets. Chromium uses a software WebGL renderer on the CI runner.

| Browser scenario              | Evidence checked                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| First load and map inspection | Real nonempty WebGL framebuffer, 512² mesh, split view, flow map, normal map                                                         |
| Parameter editing             | Changing the seed and erosion rate changes the generated height image                                                                |
| Graph authoring               | Add a noise node, choose Naki-inspired noise, undo/redo, group/ungroup, edit an annotation                                           |
| Portable projects             | Download and restore project name, seed, node parameters, graph, and notes exactly                                                   |
| Broken graph and recovery     | Keep the previous map, show a useful error, restore the connection through Undo, and reproduce every Float32 height byte             |
| Export and modal behavior     | Delete key cannot edit the graph behind a modal; download and decode a real 512², 16-bit grayscale PNG ZIP with metadata and project |

The recovery check hashes the full worker-delivered height buffer with SHA-256. This avoids conflating terrain determinism with small Canvas2D rasterization differences at image borders. It separately checks the restored displayed image. All scenarios reject browser or renderer errors.

The 28 lower-level tests cover reproducibility, distinct noises, hydraulic material accounting, thermal conservation, masks, diagnostic warping/blending, graph validation, memory preflight, project validation, physical normals and slopes, negative-elevation framing, and file encoding. PNG checks inspect the 16-bit samples and metadata reconstruction; RAW checks inspect little-endian elevations in meters.

## Full 2048 × 2048 export

A separate one-off Node process evaluated the complete default Alpine watershed graph at 2048², encoded its PNG16/metadata/project ZIP, unzipped it, parsed the PNG container, and independently inflated and checked all scanlines. This uses the same graph evaluator and export encoder as the app. It is separate from the browser's 512² download test.

| Measurement                                   | Result                                             |
| --------------------------------------------- | -------------------------------------------------- |
| Preset / seed                                 | Alpine watershed / 48271                           |
| Height samples                                | 4,194,304, all finite                              |
| Terrain generation                            | 144.22 seconds                                     |
| PNG16 + ZIP encoding                          | 1.01 seconds                                       |
| Complete generation, encoding, and validation | 145.68 seconds                                     |
| Peak Node process RSS                         | 278.09 MiB                                         |
| Maximum observed array-buffer allocation      | 176.58 MiB                                         |
| PNG dimensions                                | 2048 × 2048                                        |
| PNG encoding                                  | Grayscale color type 0, 16-bit depth               |
| Distinct encoded elevation values             | 64,819                                             |
| Samples with nonzero low bytes                | 4,178,209                                          |
| Elevation range                               | 121.060–1,894.190 meters                           |
| ZIP size                                      | 7,214,447 bytes                                    |
| Metadata and embedded project                 | Dimensions, seed, scale, range, and graph verified |

The nonzero low bytes and more than 256 distinct values confirm that the file contains genuine 16-bit height data. The hydraulic stage took approximately 136 seconds and dominated this run. Runtime varies by machine, browser, graph, and erosion settings; 2K is an export workflow, while the smaller working grid supports iteration. The measured memory belongs to the Node generation/export process and does not include a browser's interface or graphics allocations.

## Visual review

- [3D studio](images/studio-3d.png): connected broad summits, eroded shoulders, physical default scale, complete tile framing, graph, and parameter inspector.
- [Water flow](images/studio-flow.png): the actual simulation diagnostic displayed in the 2D viewer.

The review prompted refinements to the mountain source to reduce needle-like ridge intersections, separate the broad range from secondary detail, fit the full tile, and preserve visibility of valid negative elevations. The screenshots show those refinements. This verification covers Chromium on the CI runner, not a completed compatibility matrix across every browser or GPU.
