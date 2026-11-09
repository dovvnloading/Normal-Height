import { clamp, randomGenerator } from './noise';

export interface ErosionSettings {
  droplets: number;
  lifetime: number;
  inertia: number;
  capacity: number;
  erosion: number;
  deposition: number;
  evaporation: number;
  radius: number;
  gravity: number;
  seed: number;
  multiscale: boolean;
}
export interface ErosionResult {
  height: Float32Array;
  flow: Float32Array;
  wear: Float32Array;
  deposition: Float32Array;
  eroded: number;
  deposited: number;
  exportedSediment: number;
}

export function sampleHeight(map: Float32Array, n: number, x: number, y: number): number {
  x = clamp(x, 0, n - 1);
  y = clamp(y, 0, n - 1);
  const ix = Math.min(n - 2, Math.floor(x)),
    iy = Math.min(n - 2, Math.floor(y));
  const fx = x - ix,
    fy = y - iy,
    i = iy * n + ix;
  return (
    map[i] * (1 - fx) * (1 - fy) +
    map[i + 1] * fx * (1 - fy) +
    map[i + n] * (1 - fx) * fy +
    map[i + n + 1] * fx * fy
  );
}

/** Rainfall parcels carry removed material; exiting or unsettled sediment is counted. */
export function hydraulicErosion(
  input: Float32Array,
  n: number,
  settings: ErosionSettings,
  mask?: Float32Array,
  progress?: (fraction: number) => void,
): ErosionResult {
  const height = input.slice();
  const flow = new Float32Array(n * n),
    wear = new Float32Array(n * n),
    deposition = new Float32Array(n * n);
  const random = randomGenerator(settings.seed);
  let eroded = 0,
    deposited = 0,
    exportedSediment = 0;
  let bedrock = 0;
  for (let i = 0; i < input.length; i++) bedrock = Math.min(bedrock, input[i]);
  bedrock -= 0.02;
  const total = Math.round(clamp(settings.droplets, 0, 500000) * (n / 512) ** 2);
  const inertia = clamp(settings.inertia, 0, 0.95),
    capacity = clamp(settings.capacity, 0.1, 20);
  const erodeRate = clamp(settings.erosion, 0, 1),
    depositRate = clamp(settings.deposition, 0, 1);
  const evaporation = clamp(settings.evaporation, 0.001, 0.5),
    gravity = clamp(settings.gravity, 0.01, 20);
  const baseRadius = Math.round(clamp(settings.radius * Math.max(0.6, n / 512), 1, 8));
  const broadCount = settings.multiscale ? Math.floor(total * 0.32) : 0;
  let currentRadius = -1;
  let offsets: { dx: number; dy: number; weight: number }[] = [];

  const updateBrush = (radius: number) => {
    if (currentRadius === radius) return;
    currentRadius = radius;
    offsets = [];
    let sum = 0;
    for (let dy = -radius; dy <= radius; dy++)
      for (let dx = -radius; dx <= radius; dx++) {
        const weight = Math.max(0, 1 - Math.hypot(dx, dy) / (radius + 0.25));
        if (weight > 0) {
          offsets.push({ dx, dy, weight });
          sum += weight;
        }
      }
    for (const point of offsets) point.weight /= sum;
  };

  const depositAt = (x: number, y: number, amount: number): number => {
    const ix = Math.min(n - 2, Math.max(0, Math.floor(x))),
      iy = Math.min(n - 2, Math.max(0, Math.floor(y)));
    const fx = clamp(x - ix),
      fy = clamp(y - iy),
      index = iy * n + ix;
    let actual = 0;
    for (let k = 0; k < 4; k++) {
      const i = index + (k & 1) + (k > 1 ? n : 0);
      const weight = (k & 1 ? fx : 1 - fx) * (k > 1 ? fy : 1 - fy) * (mask ? clamp(mask[i]) : 1);
      const before = height[i];
      height[i] += amount * weight;
      const change = height[i] - before;
      deposition[i] += change;
      actual += change;
    }
    deposited += actual;
    return actual;
  };

  for (let droplet = 0; droplet < total; droplet++) {
    const broad = droplet < broadCount;
    updateBrush(broad ? Math.min(10, baseRadius + 2) : baseRadius);
    const lifetime = Math.round(
      clamp(settings.lifetime * Math.max(0.4, n / 512) * (broad ? 1.65 : 1), 8, 400),
    );
    let x = random() * (n - 1.001),
      y = random() * (n - 1.001);
    let dirX = 0,
      dirY = 0,
      water = 1,
      speed = 1,
      sediment = 0,
      escaped = false;

    for (let step = 0; step < lifetime && water > 0.015; step++) {
      const ix = Math.floor(x),
        iy = Math.floor(y),
        i = iy * n + ix;
      const fx = x - ix,
        fy = y - iy;
      const h00 = height[i],
        h10 = height[i + 1],
        h01 = height[i + n],
        h11 = height[i + n + 1];
      const oldHeight =
        h00 * (1 - fx) * (1 - fy) + h10 * fx * (1 - fy) + h01 * (1 - fx) * fy + h11 * fx * fy;
      const gx = (h10 - h00) * (1 - fy) + (h11 - h01) * fy;
      const gy = (h01 - h00) * (1 - fx) + (h11 - h10) * fx;
      dirX = dirX * inertia - gx * (1 - inertia);
      dirY = dirY * inertia - gy * (1 - inertia);
      const length = Math.hypot(dirX, dirY);
      if (length < 1e-10) break;
      dirX /= length;
      dirY /= length;
      const nextX = x + dirX,
        nextY = y + dirY;
      flow[i] += water;
      if (nextX < 0 || nextY < 0 || nextX >= n - 1 || nextY >= n - 1) {
        escaped = true;
        break;
      }
      const nextHeight = sampleHeight(height, n, nextX, nextY),
        delta = nextHeight - oldHeight;
      const carrying = Math.max(-delta, 0.000001) * speed * water * capacity;
      if (delta > 0 || sediment > carrying) {
        const requested =
          delta > 0 ? Math.min(sediment, delta) : (sediment - carrying) * depositRate;
        sediment = Math.max(0, sediment - depositAt(x, y, requested));
        if (delta > 0 && sediment < delta * 0.001) break;
      } else if (erodeRate > 0) {
        const requested = Math.min((carrying - sediment) * erodeRate, Math.max(0, -delta) * 0.85);
        if (requested > 0) {
          let removed = 0;
          for (const point of offsets) {
            const bx = ix + point.dx,
              by = iy + point.dy;
            if (bx < 0 || by < 0 || bx >= n || by >= n) continue;
            const bi = by * n + bx,
              before = height[bi];
            const take = Math.min(
              Math.max(0, before - bedrock),
              requested * point.weight * (mask ? clamp(mask[bi]) : 1),
            );
            height[bi] -= take;
            const change = before - height[bi];
            wear[bi] += change;
            removed += change;
          }
          sediment += removed;
          eroded += removed;
        }
      }
      speed = Math.sqrt(Math.max(0.001, speed * speed - delta * gravity));
      water *= 1 - evaporation;
      x = nextX;
      y = nextY;
    }
    if (!escaped && sediment > 0) sediment = Math.max(0, sediment - depositAt(x, y, sediment));
    // Any remaining carried material leaves this simulation: boundary runoff
    // or material that a terminal mask does not permit us to deposit locally.
    exportedSediment += sediment;
    if ((droplet & 2047) === 0) progress?.(droplet / Math.max(total, 1));
  }
  progress?.(1);
  return { height, flow, wear, deposition, eroded, deposited, exportedSediment };
}

/** Conservative talus relaxation, using simultaneous transfers to avoid directional bias. */
export function thermalErosion(
  input: Float32Array,
  n: number,
  iterations: number,
  talus: number,
  strength: number,
  progress?: (fraction: number) => void,
): Float32Array {
  const height = input.slice(),
    changes = new Float64Array(n * n);
  const count = Math.round(clamp(iterations, 0, 150));
  const threshold = (clamp(talus, 0, 0.2) * 512) / n,
    rate = clamp(strength) * 0.24;
  const directions = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ];
  for (let step = 0; step < count; step++) {
    changes.fill(0);
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const i = y * n + x,
          h = height[i];
        let lowest = -1,
          excess = 0;
        for (const [dx, dy] of directions) {
          const nx = x + dx,
            ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
          const target = ny * n + nx;
          const difference = h - height[target] - threshold * (dx && dy ? Math.SQRT2 : 1);
          if (difference > excess) {
            excess = difference;
            lowest = target;
          }
        }
        if (lowest >= 0) {
          const transfer = excess * rate;
          changes[i] -= transfer;
          changes[lowest] += transfer;
        }
      }
    for (let i = 0; i < height.length; i++) height[i] += changes[i];
    if ((step & 3) === 0) progress?.((step + 1) / Math.max(1, count));
  }
  progress?.(1);
  return height;
}
