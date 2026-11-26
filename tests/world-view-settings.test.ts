import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORLD_VIEW,
  parseWorldBookmarks,
  parseWorldViewSettings,
  worldDomainKey,
} from '../src/model/worldViewSettings';
import { createWorldDefinition } from '../src/model/world';

describe('world presentation storage', () => {
  it('rejects malformed preferences and bounds the resizable panel', () => {
    expect(parseWorldViewSettings(null)).toEqual(DEFAULT_WORLD_VIEW);
    expect(
      parseWorldViewSettings({
        mode: 'unknown',
        layer: 'fake',
        panelWidth: Infinity,
        automatic: 'yes',
      }),
    ).toEqual(DEFAULT_WORLD_VIEW);
    expect(
      parseWorldViewSettings({
        mode: 'analyze',
        layer: 'slope',
        presentation: 'split',
        panelWidth: 2000,
        cache: true,
      }),
    ).toMatchObject({
      mode: 'analyze',
      layer: 'slope',
      presentation: 'split',
      panelWidth: 420,
      cache: true,
    });
  });
  it('accepts bounded bookmarks, deduplicates IDs and rejects invalid cell bounds', () => {
    const bookmark = {
      id: 'one',
      name: '  Ridge  ',
      domain: 'domain',
      region: { startX: 0, startZ: 256, cellsX: 256, cellsZ: 256 },
    };
    expect(
      parseWorldBookmarks([
        bookmark,
        bookmark,
        { ...bookmark, id: 'two', region: { ...bookmark.region, startZ: -2 } },
      ]),
    ).toEqual([{ ...bookmark, name: 'Ridge' }]);
    expect(parseWorldBookmarks({})).toEqual([]);
  });
  it('keeps presentation bookmarks across lighting and elevation changes but invalidates changed footprints', () => {
    const world = createWorldDefinition({ worldSize: 4000, heightScale: 1800 });
    expect(worldDomainKey({ ...world, domain: { ...world.domain, datum: 300 } })).toBe(
      worldDomainKey(world),
    );
    expect(worldDomainKey({ ...world, domain: { ...world.domain, width: 8000 } })).not.toBe(
      worldDomainKey(world),
    );
  });
});
