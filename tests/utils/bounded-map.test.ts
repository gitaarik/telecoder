import { describe, it, expect } from 'vitest';
import { BoundedMap } from '../../src/utils/bounded-map.js';

describe('BoundedMap', () => {
  it('stores and retrieves values', () => {
    const m = new BoundedMap<string, number>(3);
    m.set('a', 1).set('b', 2);
    expect(m.get('a')).toBe(1);
    expect(m.get('b')).toBe(2);
    expect(m.get('missing')).toBeUndefined();
    expect(m.size).toBe(2);
  });

  it('evicts the oldest entry when capacity is exceeded', () => {
    const m = new BoundedMap<string, number>(2);
    m.set('a', 1).set('b', 2).set('c', 3);
    expect(m.size).toBe(2);
    expect(m.has('a')).toBe(false); // oldest evicted
    expect(m.has('b')).toBe(true);
    expect(m.has('c')).toBe(true);
  });

  it('re-setting an existing key moves it to most-recent (avoids eviction)', () => {
    const m = new BoundedMap<string, number>(2);
    m.set('a', 1).set('b', 2);
    m.set('a', 10); // refresh 'a'
    m.set('c', 3); // should evict 'b', not 'a'
    expect(m.has('a')).toBe(true);
    expect(m.get('a')).toBe(10);
    expect(m.has('b')).toBe(false);
    expect(m.has('c')).toBe(true);
  });

  it('delete removes a key and reports success', () => {
    const m = new BoundedMap<string, number>();
    m.set('a', 1);
    expect(m.delete('a')).toBe(true);
    expect(m.delete('a')).toBe(false);
    expect(m.has('a')).toBe(false);
  });

  it('clear empties the map', () => {
    const m = new BoundedMap<string, number>();
    m.set('a', 1).set('b', 2);
    m.clear();
    expect(m.size).toBe(0);
  });

  it('exposes iterators and forEach', () => {
    const m = new BoundedMap<string, number>();
    m.set('a', 1).set('b', 2);
    expect([...m.keys()]).toEqual(['a', 'b']);
    expect([...m.values()]).toEqual([1, 2]);
    expect([...m.entries()]).toEqual([['a', 1], ['b', 2]]);
    const seen: string[] = [];
    m.forEach((_v, k) => seen.push(k));
    expect(seen).toEqual(['a', 'b']);
  });

  it('defaults to a capacity of 1000', () => {
    const m = new BoundedMap<number, number>();
    for (let i = 0; i < 1001; i++) m.set(i, i);
    expect(m.size).toBe(1000);
    expect(m.has(0)).toBe(false); // first one evicted
    expect(m.has(1000)).toBe(true);
  });
});
