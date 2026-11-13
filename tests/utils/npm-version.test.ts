import { describe, it, expect, vi } from 'vitest';
import {
  compareVersions,
  compareInstalled,
  describeNpmCheck,
  getLatestVersion,
  updateCommand,
} from '../../src/utils/npm-version.js';

describe('compareVersions', () => {
  it('orders by the numeric parts', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.2.3', '1.10.0')).toBe(-1);
    expect(compareVersions('2.0.0', '1.99.99')).toBe(1);
  });

  it('puts a prerelease below its release', () => {
    expect(compareVersions('1.2.0-beta.1', '1.2.0')).toBe(-1);
    expect(compareVersions('1.2.0', '1.2.0-beta.1')).toBe(1);
  });
});

describe('compareInstalled / describeNpmCheck', () => {
  it('is unknown without an answer from npm', () => {
    const check = compareInstalled('1.1.0', null);
    expect(check.kind).toBe('unknown');
    expect(describeNpmCheck(check, 'global')).toContain("Couldn't ask npm");
  });

  it('points a global install at /update and others at their command', () => {
    const check = compareInstalled('1.1.0', '1.2.0');
    expect(check.kind).toBe('behind');
    expect(describeNpmCheck(check, 'global')).toContain('/update');
    expect(describeNpmCheck(check, 'npx')).toContain(updateCommand('npx'));
  });

  it('is current when they match', () => {
    expect(compareInstalled('1.2.0', '1.2.0').kind).toBe('current');
  });
});

describe('getLatestVersion', () => {
  it('asks npm once and answers from the cache after that', async () => {
    const fetch = vi.fn(async () => '9.9.9');
    const now = Date.now();
    expect(await getLatestVersion({ fresh: true, fetch, now })).toBe('9.9.9');
    const again = vi.fn(async () => '0.0.1');
    expect(await getLatestVersion({ fetch: again, now: now + 1000 })).toBe('9.9.9');
    expect(again).not.toHaveBeenCalled();
  });

  it('asks again once the cache is stale', async () => {
    const now = Date.now();
    await getLatestVersion({ fresh: true, fetch: async () => '1.0.0', now });
    const later = vi.fn(async () => '1.0.1');
    expect(await getLatestVersion({ fetch: later, now: now + 7 * 60 * 60 * 1000 })).toBe('1.0.1');
  });
});
