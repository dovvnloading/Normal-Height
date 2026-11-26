/** Keep the limiting field of view stable when a wide terrain pane becomes a narrow split. */
export function terrainAspectScale(aspect: number) {
  return 1 / Math.min(1, Number.isFinite(aspect) && aspect > 0 ? aspect : 1);
}

/** Applied to an existing orbit offset, preserving its direction and relative user zoom. */
export function terrainAspectResize(previousAspect: number, nextAspect: number) {
  return terrainAspectScale(nextAspect) / terrainAspectScale(previousAspect);
}
