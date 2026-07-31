import { describe, expect, it } from 'vitest';
import { makeRng, next, nextInt, rollDice, shuffle } from './rng.js';

describe('rng', () => {
  it('is deterministic for a given seed', () => {
    const a = rollDice(makeRng(12345), 6);
    const b = rollDice(makeRng(12345), 6);
    expect(a[0]).toEqual(b[0]);
    expect(a[1]).toEqual(b[1]);
  });

  it('produces different streams for different seeds', () => {
    const a = rollDice(makeRng(1), 20)[0];
    const b = rollDice(makeRng(2), 20)[0];
    expect(a).not.toEqual(b);
  });

  it('never mutates the input state', () => {
    const rng = makeRng(7);
    const before = { ...rng };
    next(rng);
    nextInt(rng, 10);
    shuffle(rng, [1, 2, 3]);
    rollDice(rng, 3);
    expect(rng).toEqual(before);
  });

  it('advances the counter by one per draw', () => {
    const [, r1] = next(makeRng(9));
    expect(r1.counter).toBe(1);
    const [, , r2] = rollDice(makeRng(9), 6);
    expect(r2.counter).toBe(6);
  });

  it('rolls dice with faces in {0,1,2}', () => {
    const [faces, total] = rollDice(makeRng(42), 100);
    expect(faces).toHaveLength(100);
    for (const f of faces) expect([0, 1, 2]).toContain(f);
    expect(total).toBe(faces.reduce((a, b) => a + b, 0));
  });

  it('rolls a plausible distribution over many samples', () => {
    // 6 dice of mean 1 each => mean 6. Guards against an off-by-one that
    // would silently bias every haunt roll in the game.
    let rng = makeRng(2024);
    let sum = 0;
    const trials = 4000;
    for (let i = 0; i < trials; i++) {
      const [, total, r] = rollDice(rng, 6);
      rng = r;
      sum += total;
    }
    expect(sum / trials).toBeGreaterThan(5.7);
    expect(sum / trials).toBeLessThan(6.3);
  });

  it('shuffle is a permutation and does not mutate the input', () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const [out] = shuffle(makeRng(3), input);
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([...out].sort((a, b) => a - b)).toEqual(input);
  });

  it('nextInt stays in range', () => {
    let rng = makeRng(11);
    for (let i = 0; i < 500; i++) {
      const [v, r] = nextInt(rng, 7);
      rng = r;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
    }
  });
});
