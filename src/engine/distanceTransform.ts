/**
 * out[p] = min_q (line[q] + c · (p − q)²), in linear time.
 * The envelope of parabolas is represented by its sites and their left
 * intersection bounds (Felzenszwalb & Huttenlocher, 2012). Supply finite
 * costs, c > 0, and one extra entry in the reusable bounds workspace.
 */
export function lowerParabolicEnvelope(
  line: Float64Array,
  out: Float64Array,
  sites: Int32Array,
  bounds: Float64Array,
  c: number,
): void {
  const total = line.length;
  let k = 0;
  sites[0] = 0;
  bounds[0] = -Infinity;
  bounds[1] = Infinity;
  for (let q = 1; q < total; q++) {
    let r = sites[k];
    let cross = (line[q] + c * q * q - (line[r] + c * r * r)) / (2 * c * (q - r));
    while (cross <= bounds[k]) {
      k--;
      r = sites[k];
      cross = (line[q] + c * q * q - (line[r] + c * r * r)) / (2 * c * (q - r));
    }
    k++;
    sites[k] = q;
    bounds[k] = cross;
    bounds[k + 1] = Infinity;
  }
  k = 0;
  for (let p = 0; p < total; p++) {
    while (bounds[k + 1] < p) k++;
    const q = sites[k];
    out[p] = line[q] + c * (p - q) * (p - q);
  }
}
