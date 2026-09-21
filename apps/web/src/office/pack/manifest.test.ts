import { describe, expect, it } from 'vitest';
import { REQUIRED_SPRITES, validateManifest, type PackManifest } from './manifest';

const sprite = { frames: [{ x: 0, y: 0, w: 8, h: 8 }], anchor: { x: 4, y: 8 }, fps: 0 };
const valid = (): PackManifest => ({
  name: 'test',
  tile: { w: 64, h: 32 },
  sprites: Object.fromEntries(REQUIRED_SPRITES.map((k) => [k, sprite])),
  head: { x: 0, y: -30 },
  skin: [1, 2, 3, 4, 5, 6],
  hair: [1, 2, 3, 4, 5, 6],
});

describe('validateManifest', () => {
  it('accepts a complete manifest', () => {
    expect(validateManifest(valid())).toEqual([]);
  });
  it('names every missing sprite', () => {
    const m = valid();
    delete m.sprites['person/raise/shirt'];
    delete m.sprites['desk'];
    expect(validateManifest(m)).toEqual(['missing sprite: desk', 'missing sprite: person/raise/shirt']);
  });
  it('rejects a sprite with no frames, an animated one with no fps, and short tint lists', () => {
    const m = valid();
    m.sprites['chair'] = { ...sprite, frames: [] };
    m.sprites['person/type/body'] = { ...sprite, frames: [sprite.frames[0], sprite.frames[0]], fps: 0 };
    m.skin = [1];
    expect(validateManifest(m)).toEqual(['sprite chair has no frames', 'sprite person/type/body has 2 frames but no fps', 'skin needs 6 tints, has 1']);
  });
  it('covers every animation with a body and a shirt', () => {
    for (const a of ['sit', 'type', 'raise', 'sleep', 'shake']) {
      expect(REQUIRED_SPRITES).toContain(`person/${a}/body`);
      expect(REQUIRED_SPRITES).toContain(`person/${a}/shirt`);
    }
  });
});
