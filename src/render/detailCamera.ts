/** Surface inspection is opt-in through focusing a point. World-meter
 * limits make a close terrain shot possible on both small and large worlds.
 */
export const OVERVIEW_MIN_DISTANCE = 0.045;
export function inspectionMinDistance(metersPerUnit: number): number {
  if (!(metersPerUnit > 0) || !Number.isFinite(metersPerUnit)) return OVERVIEW_MIN_DISTANCE;
  return Math.min(OVERVIEW_MIN_DISTANCE, Math.max(0.0015, 8/metersPerUnit));
}

export function inspectionNearPlane(orbitDistance: number): number {
  if (!(orbitDistance > 0) || !Number.isFinite(orbitDistance)) return 0.002;
  return Math.min(0.002, Math.max(0.00005, orbitDistance*0.035));
}

export function shouldPrepareLocalTextures(
  enabled: boolean, orbitDistance: number, viewportHeight: number,
  fovDegrees: number, metersPerUnit: number, tileMeters: number,
): boolean {
  if (!enabled || ![orbitDistance,viewportHeight,metersPerUnit,tileMeters].every(v=>Number.isFinite(v)&&v>0))
    return false;
  const footprint=orbitDistance*metersPerUnit*2*Math.tan(fovDegrees*Math.PI/360)/viewportHeight;
  return Number.isFinite(footprint) && footprint < 0.75*tileMeters;
}
