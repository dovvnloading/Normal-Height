/**
 * Repartition natural non-snow coverage at mineral, sediment and vegetation
 * contacts. This is area coverage, not a height offset or baked lighting.
 * Snow retention is preserved; a substrate absent from the classifier stays
 * absent. Paint is applied AFTER this function, so authored coverage is exact.
 */
export interface ContactFabric {
  facies: number;
  fleck: number;
  clasts: number;
  hummock: number;
  straw: number;
}

export function shapeNaturalContacts(weights: number[], fabric: ContactFabric): void {
  const available = weights[0] + weights[1] + weights[2];
  if (available <= 1e-10) return;
  const rock = weights[0] / available;
  const soil = weights[1] / available;
  const plant = weights[2] / available;
  // Continuous, bounded coverage competition. A coherent facies moves the
  // rock contact, clasts favor exposed sediment, and canopy/litter compete
  // for growing space. Contrast acts on existing coverage, never invents it.
  const a = rock * (1 + 0.55 * rock + 0.29 * fabric.facies + 0.14 * fabric.fleck);
  const b = soil * (1 + 0.55 * soil - 0.19 * fabric.facies + 0.22 * fabric.clasts);
  const c = plant * (1 + 0.55 * plant - 0.10 * fabric.facies
    + 0.24 * fabric.hummock - 0.12 * fabric.straw);
  const total = a + b + c;
  weights[0] = available * a / total;
  weights[1] = available * b / total;
  weights[2] = available * c / total;
}
