import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock DNS so hostname resolution is deterministic and offline.
const lookupMock = vi.fn();
vi.mock('dns', () => ({
  promises: {
    lookup: (...args: unknown[]) => lookupMock(...args),
  },
}));

import { isUrlAllowed } from '../../src/utils/url-guard.js';

describe('isUrlAllowed', () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  it('rejects malformed URLs', async () => {
    expect(await isUrlAllowed('not a url')).toBe(false);
  });

  it('rejects non-http(s) protocols', async () => {
    expect(await isUrlAllowed('ftp://example.com')).toBe(false);
    expect(await isUrlAllowed('file:///etc/passwd')).toBe(false);
  });

  it('rejects localhost and *.localhost', async () => {
    expect(await isUrlAllowed('http://localhost/x')).toBe(false);
    expect(await isUrlAllowed('http://api.localhost/x')).toBe(false);
  });

  it('rejects private IPv4 literals without a DNS lookup', async () => {
    for (const host of ['10.0.0.1', '172.16.5.4', '192.168.1.1', '127.0.0.1', '169.254.1.1']) {
      expect(await isUrlAllowed(`http://${host}/`)).toBe(false);
    }
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('allows a public IPv4 literal without a DNS lookup', async () => {
    expect(await isUrlAllowed('https://8.8.8.8/')).toBe(true);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('rejects IPv6 loopback and unique/link-local literals', async () => {
    expect(await isUrlAllowed('http://[::1]/')).toBe(false);
    expect(await isUrlAllowed('http://[fc00::1]/')).toBe(false);
    expect(await isUrlAllowed('http://[fe80::1]/')).toBe(false);
  });

  it('allows a hostname that resolves to a public IP', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    expect(await isUrlAllowed('https://example.com/')).toBe(true);
    expect(lookupMock).toHaveBeenCalledWith('example.com', { all: true });
  });

  it('rejects a hostname that resolves to a private IP (DNS rebinding guard)', async () => {
    lookupMock.mockResolvedValue([{ address: '192.168.0.5', family: 4 }]);
    expect(await isUrlAllowed('https://evil.example/')).toBe(false);
  });

  it('rejects a hostname when DNS resolution fails (fail closed)', async () => {
    lookupMock.mockRejectedValue(new Error('ENOTFOUND'));
    expect(await isUrlAllowed('https://nope.example/')).toBe(false);
  });
});
