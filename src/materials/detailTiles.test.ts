import { describe, expect, it } from 'vitest';
import { DetailTileSampler, detailTileMeters, generateDetailTile, type DetailSample } from './detailTiles';
import { resolveSurface } from './pbr';
import type { MaterialLayer } from './materialPaint';

const fresh = (): DetailSample => ({ red: 0, green: 0, blue: 0, roughness: 0, reliefMeters: 0 });
const layers: MaterialLayer[] = ['rock', 'soil', 'vegetation', 'snow'];

describe('portable material detail tiles', () => {
  it.each(['alpine','arid','volcanic'] as const)('%s tiles repeat in both axes, including relief and reflectance', biome => {
    for (const layer of layers) {
      const sampler = new DetailTileSampler(layer, { ...resolveSurface(), biome }, 153, 512);
      for (let i = 0; i < 17; i++) {
        const u = i * 0.129 - 0.22, v = i * 0.093 + 0.12;
        const a = sampler.sample(u, v, fresh()), b = sampler.sample(u+1, v-1, fresh());
        for (const key of Object.keys(a) as (keyof DetailSample)[])
          expect(a[key], layer + ':' + key).toBeCloseTo(b[key], 8);
      }
      // A seam must be continuous, not merely share two duplicate border pixels.
      const a = sampler.sample(0.000001, 0.37, fresh());
      const b = sampler.sample(0.999999, 0.37, fresh());
      expect(Math.abs(a.reliefMeters-b.reliefMeters)).toBeLessThan(0.0001);
    }
  });

  it('uses a compact physical period, independent of terrain extent', () => {
    expect(detailTileMeters(24)).toBe(6);
    expect(detailTileMeters(4)).toBe(2);
    expect(detailTileMeters(200)).toBe(16);
  });

  it('produces distinct, deterministic surface maps with aligned non-color data', () => {
    const scene = resolveSurface(), maps = layers.map(layer => generateDetailTile(layer, scene, 9, 64));
    expect(generateDetailTile('rock', scene, 9, 64)).toEqual(maps[0]);
    expect(generateDetailTile('rock', scene, 10, 64).basecolor).not.toEqual(maps[0].basecolor);
    expect(generateDetailTile('rock', { ...scene, biome: 'volcanic' }, 9, 64).basecolor).not.toEqual(maps[0].basecolor);
    for (let j = 0; j < maps.length; j++) {
      const tile = maps[j], n = tile.resolution;
      expect(tile.basecolor).toHaveLength(n*n*4);
      expect(tile.orm).toHaveLength(n*n*4);
      expect(tile.relief).toHaveLength(n*n);
      let min = 255, max = 0, tilted = 0;
      for (let i = 0; i < n*n; i++) {
        const p = 4*i;
        expect(tile.basecolor[p+3]).toBe(255);
        expect(tile.orm[p+2]).toBe(0);
        expect(tile.orm[p+3]).toBe(255);
        expect(tile.normal[p+3]).toBe(255);
        const x = tile.normal[p]/127.5-1, y = tile.normal[p+1]/127.5-1, z = tile.normal[p+2]/127.5-1;
        expect(Math.abs(Math.hypot(x,y,z)-1)).toBeLessThan(0.008);
        if (Math.abs(x)+Math.abs(y)>0.04) tilted++;
        min = Math.min(min,tile.orm[p+1]); max = Math.max(max,tile.orm[p+1]);
      }
      expect(tilted).toBeGreaterThan(n*n/12);
      expect(max-min).toBeGreaterThan(8);
      for (let k = j+1; k < maps.length; k++) expect(tile.relief).not.toEqual(maps[k].relief);
    }
  });

  it('derives edge normals from periodic neighbors and honors zero relief strength', () => {
    const n = 32, scene = resolveSurface(), maps = generateDetailTile('soil', scene, 4, n);
    const dx = (maps.relief[1] - maps.relief[n-1]) / (2*maps.meters/n);
    const dy = (maps.relief[n] - maps.relief[(n-1)*n]) / (2*maps.meters/n);
    const len = Math.hypot(dx,dy,1);
    expect([...maps.normal.slice(0,4)]).toEqual([
      Math.round(255*(0.5-0.5*dx/len)), Math.round(255*(0.5+0.5*dy/len)),
      Math.round(255*(0.5+0.5/len)),255,
    ]);
    const flat = generateDetailTile('rock', { ...scene, detailStrength: 0 }, 4, n);
    expect(flat.relief.every(h => h === 0)).toBe(true);
    expect([...flat.normal.slice(0,4)]).toEqual([128,128,255,255]);
    expect(flat.orm[0]).toBe(255);
  });
});
