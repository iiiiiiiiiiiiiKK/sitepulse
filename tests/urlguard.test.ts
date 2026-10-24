import { describe, expect, it } from 'vitest';
import {
  assertProbeableUrl,
  checkHostname,
  expandIPv6,
  isPublicAddress,
  isPublicIPv4,
  isPublicIPv6,
} from '../worker/lib/urlguard';

/**
 * SSRF guard tests. These are the highest-risk tests in the project: a
 * regression here means the product can be used to reach internal networks.
 */

const noDns = { resolver: null };

describe('isPublicIPv4', () => {
  const blocked = [
    '127.0.0.1',
    '127.255.255.254',
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.1',
    '192.168.255.255',
    '169.254.169.254', // AWS/GCP metadata
    '169.254.0.1',
    '100.64.0.1', // CGNAT
    '0.0.0.0',
    '0.1.2.3',
    '192.0.0.1',
    '192.0.2.5',
    '198.18.0.1',
    '198.51.100.7',
    '203.0.113.9',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
  ];
  for (const ip of blocked) {
    it(`blocks ${ip}`, () => {
      expect(isPublicIPv4(ip)).toBe(false);
    });
  }

  const allowed = ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.15.255.255', '172.32.0.1', '11.0.0.1'];
  for (const ip of allowed) {
    it(`allows ${ip}`, () => {
      expect(isPublicIPv4(ip)).toBe(true);
    });
  }
});

describe('expandIPv6 / isPublicIPv6', () => {
  it('expands a compressed address', () => {
    expect(expandIPv6('2001:db8::1')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
    expect(expandIPv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIPv6('::')).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('expands a full address', () => {
    expect(expandIPv6('2606:4700:4700:0000:0000:0000:0000:1111')).toEqual([
      0x2606, 0x4700, 0x4700, 0, 0, 0, 0, 0x1111,
    ]);
  });

  it('rejects malformed input', () => {
    expect(expandIPv6('2001:db8::1::2')).toBeNull();
    expect(expandIPv6('not-an-ip')).toBeNull();
  });

  it('blocks loopback, unique-local, link-local, multicast, IPv4-mapped private', () => {
    for (const ip of [
      '::1',
      '::',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      '64:ff9b::a00:1',
      '2002:7f00:1::1',
      '2001:db8::1',
    ]) {
      expect(isPublicIPv6(ip), ip).toBe(false);
    }
  });

  it('allows a global unicast address', () => {
    expect(isPublicIPv6('2606:4700:4700::1111')).toBe(true);
    expect(isPublicIPv6('::ffff:1.1.1.1')).toBe(true);
  });

  it('isPublicAddress handles both families', () => {
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('127.0.0.1')).toBe(false);
    expect(isPublicAddress('2606:4700::1')).toBe(true);
    expect(isPublicAddress('nonsense')).toBe(false);
  });
});

describe('checkHostname', () => {
  it('blocks internal hostnames', () => {
    for (const host of [
      'localhost',
      'LOCALHOST',
      'metadata.google.internal',
      'metadata',
      'foo.localhost',
      'printer.local',
      'db.internal',
      'kubernetes.default',
      '0',
      '0.0.0.0',
    ]) {
      expect(checkHostname(host), host).not.toBeNull();
    }
  });

  it('blocks encoded private IPv4 forms', () => {
    // 2130706433 === 127.0.0.1
    expect(checkHostname('2130706433')).not.toBeNull();
    // hex-ish single integer equal to 10.0.0.1 → 167772161
    expect(checkHostname('167772161')).not.toBeNull();
  });

  it('allows a normal public hostname', () => {
    expect(checkHostname('example.com')).toBeNull();
    expect(checkHostname('sub.example.co.uk')).toBeNull();
  });

  it('blocks literal private addresses', () => {
    expect(checkHostname('127.0.0.1')).not.toBeNull();
    expect(checkHostname('10.1.2.3')).not.toBeNull();
    expect(checkHostname('[::1]')).not.toBeNull();
    expect(checkHostname('::1')).not.toBeNull();
  });
});

describe('assertProbeableUrl', () => {
  it('rejects non-http protocols', async () => {
    const result = await assertProbeableUrl('ftp://example.com', noDns);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('scheme');
  });

  it('rejects file:// and javascript:', async () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi']) {
      const result = await assertProbeableUrl(url, noDns);
      expect(result.ok, url).toBe(false);
    }
  });

  it('rejects embedded credentials', async () => {
    const result = await assertProbeableUrl('https://user:pass@example.com', noDns);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('credentials');
  });

  it('rejects non allow-listed ports (no port scanning)', async () => {
    for (const port of ['22', '3306', '6379', '9200', '25']) {
      const result = await assertProbeableUrl(`https://example.com:${port}/`, noDns);
      expect(result.ok, port).toBe(false);
      if (!result.ok) expect(result.code).toBe('port');
    }
  });

  it('allows the allow-listed ports', async () => {
    for (const port of ['', ':80', ':443', ':8080', ':8443']) {
      const result = await assertProbeableUrl(`http://example.com${port}/`, noDns);
      expect(result.ok, port).toBe(true);
    }
  });

  it('rejects private and metadata targets', async () => {
    for (const url of [
      'http://127.0.0.1/',
      'http://localhost:8080/admin',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/',
      'http://192.168.1.1/',
      'http://10.0.0.5/status',
      'http://metadata.google.internal/computeMetadata/v1/',
      'http://100.64.0.1/',
    ]) {
      const result = await assertProbeableUrl(url, noDns);
      expect(result.ok, url).toBe(false);
    }
  });

  it('accepts a public URL', async () => {
    const result = await assertProbeableUrl('https://example.com/path?a=1', noDns);
    expect(result.ok).toBe(true);
  });

  it('blocks a hostname whose DNS answer is private (rebinding attempt)', async () => {
    const result = await assertProbeableUrl('https://evil-host.com/', {
      resolver: async () => ['93.184.216.34', '127.0.0.1'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('ip');
  });

  it('fails closed when the resolver itself errors', async () => {
    const result = await assertProbeableUrl('https://flaky-host.com/', {
      resolver: async () => {
        throw new Error('boom');
      },
    });
    expect(result.ok).toBe(false);
    // Distinct from 'dns': our resolver outage must not be reported as the
    // monitored site having broken DNS.
    if (!result.ok) expect(result.code).toBe('resolver');
  });

  it('fails closed when DNS returns nothing', async () => {
    const result = await assertProbeableUrl('https://empty-host.com/', {
      resolver: async () => [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('dns');
  });

  it('accepts a hostname whose DNS answers are all public', async () => {
    const result = await assertProbeableUrl('https://good-host.com/', {
      resolver: async () => ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.addresses).toHaveLength(2);
  });

  it('rejects unparsable URLs', async () => {
    const result = await assertProbeableUrl('http://', noDns);
    expect(result.ok).toBe(false);
  });
});
