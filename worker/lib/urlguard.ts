/**
 * SSRF guard.
 *
 * Every outbound probe must pass through `resolveTarget()`:
 *
 *  1. scheme must be http/https
 *  2. URL must not embed credentials (user:pass@host)
 *  3. port must be in the small allow-list (no port scanning)
 *  4. hostname must not be a known-internal name (localhost, *.internal, metadata.*)
 *  5. hostname must not literally be a private / loopback / link-local / metadata IP
 *  6. hostname is resolved over DNS-over-HTTPS and EVERY resolved address must be
 *     public. This is done per hop, so a redirect target is validated again.
 *
 * Residual risk (documented in SECURITY.md): Workers cannot pin the IP used by
 * `fetch`, so a DNS answer that differs between our DoH lookup and the edge
 * resolver could still reach an internal address. The DoH check plus the
 * name/IP block-lists close the practical attack surface; there is no
 * "connect to arbitrary IP" primitive exposed by this product.
 */

export type GuardFailure = {
  ok: false;
  reason: string;
  code:
    | 'scheme'
    | 'credentials'
    | 'port'
    | 'hostname'
    | 'ip'
    | 'dns'
    | 'resolver'
    | 'parse';
};

export type GuardSuccess = {
  ok: true;
  url: URL;
  addresses: string[];
};

export type GuardResult = GuardSuccess | GuardFailure;

const ALLOWED_PORTS = new Set([80, 443, 8080, 8443]);
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** Internal-only host suffixes. Anything ending with these is refused outright. */
const BLOCKED_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.localdomain',
  '.internal',
  '.intranet',
  '.lan',
  '.home.arpa',
  '.corp',
  '.private',
  '.test',
  '.invalid',
  '.example',
];

/** Exact hostnames that are always internal or metadata endpoints. */
const BLOCKED_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
  'kubernetes',
  'kubernetes.default',
  'kubernetes.default.svc',
]);

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

const V4_BLOCKS: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (includes 169.254.169.254 metadata)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];

export function isPublicIPv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === null) return false;
  for (const [base, bits] of V4_BLOCKS) {
    const baseValue = ipv4ToInt(base);
    if (baseValue === null) continue;
    const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
    if ((value & mask) === (baseValue & mask)) return false;
  }
  return true;
}

/** Parses a colon-separated hextet list into words; returns null on bad input. */
function parseHextets(segments: string[]): number[] | null {
  const words: number[] = [];
  for (const segment of segments) {
    if (segment === '') return null;
    if (segment.includes('.')) {
      const v4 = ipv4ToInt(segment);
      if (v4 === null) return null;
      words.push((v4 >>> 16) & 0xffff, v4 & 0xffff);
    } else {
      if (!/^[0-9a-f]{1,4}$/.test(segment)) return null;
      words.push(parseInt(segment, 16));
    }
  }
  return words;
}

/** Expands an IPv6 address into its 8 hextet words, or null if unparsable. */
export function expandIPv6(ip: string): number[] | null {
  let text = ip.trim().toLowerCase();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  if (text.includes('%')) text = text.split('%')[0]; // strip zone id
  if (!/^[0-9a-f:.]+$/.test(text)) return null;

  const parts = text.split('::');
  if (parts.length > 2) return null;

  if (parts.length === 1) {
    const words = parseHextets(parts[0].split(':'));
    return words && words.length === 8 ? words : null;
  }

  const headPart = parts[0] === '' ? [] : parts[0].split(':');
  const tailPart = parts[1] === '' ? [] : parts[1].split(':');
  const head = parseHextets(headPart);
  const tail = parseHextets(tailPart);
  if (!head || !tail) return null;
  const zeros = 8 - head.length - tail.length;
  if (zeros < 1) return null;
  return [...head, ...new Array<number>(zeros).fill(0), ...tail];
}

function v4FromWords(high: number, low: number): string {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

export function isPublicIPv6(ip: string): boolean {
  const words = expandIPv6(ip);
  if (!words) return false;

  // ::ffff:a.b.c.d (IPv4-mapped) and ::a.b.c.d (IPv4-compatible)
  const firstFiveZero = words.slice(0, 5).every((w) => w === 0);
  if (firstFiveZero && (words[5] === 0xffff || words[5] === 0)) {
    return isPublicIPv4(v4FromWords(words[6], words[7]));
  }
  // 64:ff9b::/96 NAT64
  if (words[0] === 0x64 && words[1] === 0xff9b) {
    return isPublicIPv4(v4FromWords(words[6], words[7]));
  }
  // 2002::/16 6to4 embeds an IPv4 address
  if (words[0] === 0x2002) {
    return isPublicIPv4(v4FromWords(words[1], words[2]));
  }

  if (words.every((w) => w === 0)) return false; // ::
  if (words.slice(0, 7).every((w) => w === 0) && words[7] === 1) return false; // ::1
  if ((words[0] & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((words[0] & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((words[0] & 0xff00) === 0xff00) return false; // ff00::/8 multicast
  if (words[0] === 0x2001 && words[1] === 0x0db8) return false; // 2001:db8::/32 doc
  if (words[0] === 0x0100 && words[1] === 0 && words[2] === 0 && words[3] === 0) return false; // 100::/64 discard
  if (words[0] === 0x2001 && words[1] === 0x0000) return false; // 2001::/32 Teredo

  return true;
}

export function isPublicAddress(address: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) return isPublicIPv4(address);
  if (address.includes(':')) return isPublicIPv6(address);
  return false;
}

function normalizeHostname(hostname: string): string {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  while (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

export function checkHostname(hostname: string): GuardResult | null {
  const host = normalizeHostname(hostname);
  if (!host) {
    return { ok: false, code: 'hostname', reason: 'Hostname is empty.' };
  }
  if (BLOCKED_HOSTS.has(host)) {
    return { ok: false, code: 'hostname', reason: `Refusing to probe internal host "${host}".` };
  }
  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (host.endsWith(suffix)) {
      return {
        ok: false,
        code: 'hostname',
        reason: `Refusing to probe internal host "${host}" (blocked suffix ${suffix}).`,
      };
    }
  }
  if (host === '0' || host === '0.0.0.0') {
    return { ok: false, code: 'hostname', reason: 'Refusing to probe the wildcard address.' };
  }
  // Decimal / octal / hex encoded IPv4 (e.g. 2130706433 == 127.0.0.1)
  if (/^\d+$/.test(host)) {
    const asInt = Number(host);
    if (Number.isFinite(asInt) && asInt >= 0 && asInt <= 0xffffffff) {
      const encoded = [
        (asInt >>> 24) & 0xff,
        (asInt >>> 16) & 0xff,
        (asInt >>> 8) & 0xff,
        asInt & 0xff,
      ].join('.');
      if (!isPublicIPv4(encoded)) {
        return { ok: false, code: 'ip', reason: 'Refusing to probe an encoded private address.' };
      }
    }
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && !isPublicIPv4(host)) {
    return { ok: false, code: 'ip', reason: `Refusing to probe private address ${host}.` };
  }
  if (host.includes(':') && !isPublicIPv6(host)) {
    return { ok: false, code: 'ip', reason: `Refusing to probe private IPv6 address ${host}.` };
  }
  return null;
}

export type DnsResolver = (hostname: string) => Promise<string[]>;

const DOH_ENDPOINTS = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve'];

async function dohQuery(
  endpoint: string,
  hostname: string,
  type: 'A' | 'AAAA'
): Promise<string[]> {
  const url = `${endpoint}?name=${encodeURIComponent(hostname)}&type=${type}`;
  let lastError: unknown = null;
  // Two attempts: a transient 429/5xx from the public resolver must not be
  // mistaken for the monitored site's own DNS being broken.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/dns-json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`DoH ${type} lookup failed with HTTP ${res.status}`);
      const body = (await res.json()) as {
        Status?: number;
        Answer?: Array<{ type: number; data: string }>;
      };
      // NXDOMAIN (3) means "the name does not exist" — a legitimate, empty answer.
      if (body.Status === 3) return [];
      if (body.Status !== 0 || !body.Answer) return [];
      return body.Answer.filter((a) => a.type === 1 || a.type === 28).map((a) => a.data);
    } catch (error) {
      lastError = error;
      if (attempt === 1) await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`DoH ${type} lookup failed.`);
}

/**
 * Resolves A + AAAA records through DNS-over-HTTPS.
 *
 * Uses two independent resolvers, because a single DoH provider having a bad
 * minute must not manufacture a fake outage for the monitored site. The first
 * provider that answers wins; if both fail we throw and the caller fails closed.
 */
export const dohResolver: DnsResolver = async (hostname) => {
  let lastError: unknown = null;
  for (const endpoint of DOH_ENDPOINTS) {
    try {
      const [a, aaaa] = await Promise.all([
        dohQuery(endpoint, hostname, 'A'),
        dohQuery(endpoint, hostname, 'AAAA'),
      ]);
      return [...a, ...aaaa];
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('All DNS-over-HTTPS resolvers failed.');
};

export interface GuardOptions {
  /** Skip the DoH resolution step (used by unit tests only). */
  resolver?: DnsResolver | null;
}

/**
 * Validates a URL for probing, including DNS resolution of the hostname.
 */
export async function assertProbeableUrl(
  rawUrl: string,
  options: GuardOptions = {}
): Promise<GuardResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, code: 'parse', reason: 'That is not a valid URL.' };
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return {
      ok: false,
      code: 'scheme',
      reason: 'Only http:// and https:// URLs can be monitored.',
    };
  }
  if (url.username || url.password) {
    return {
      ok: false,
      code: 'credentials',
      reason: 'URLs with embedded credentials are not accepted.',
    };
  }

  const explicitPort = url.port === '' ? null : Number(url.port);
  if (explicitPort !== null && !ALLOWED_PORTS.has(explicitPort)) {
    return {
      ok: false,
      code: 'port',
      reason: `Port ${explicitPort} is not allowed. Allowed ports: 80, 443, 8080, 8443.`,
    };
  }

  const hostname = normalizeHostname(url.hostname);
  const hostProblem = checkHostname(hostname);
  if (hostProblem && hostProblem.ok === false) return hostProblem;

  const isLiteralAddress = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':');
  if (isLiteralAddress) {
    return { ok: true, url, addresses: [hostname] };
  }

  const resolver = options.resolver === undefined ? dohResolver : options.resolver;
  if (!resolver) {
    return { ok: true, url, addresses: [] };
  }

  let addresses: string[];
  try {
    addresses = await resolver(hostname);
  } catch (error) {
    // `resolver` means *our* DNS-over-HTTPS lookup failed — that is an
    // infrastructure problem, not proof that the monitored site is broken, so
    // it is reported separately and never opens an incident as a site outage.
    return {
      ok: false,
      code: 'resolver',
      reason: `Address lookup for ${hostname} failed (${
        error instanceof Error ? error.message : 'unknown error'
      }). Probe blocked to keep the target safe.`,
    };
  }

  const usable = addresses.filter((address) => address);
  if (usable.length === 0) {
    return {
      ok: false,
      code: 'dns',
      reason: `DNS returned no A/AAAA records for ${hostname}.`,
    };
  }
  const blocked = usable.filter((address) => !isPublicAddress(address));
  if (blocked.length > 0) {
    return {
      ok: false,
      code: 'ip',
      reason: `${hostname} resolves to a non-public address (${blocked[0]}). Probe blocked.`,
    };
  }
  return { ok: true, url, addresses: usable };
}
