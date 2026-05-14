import * as dns from 'dns';
import { ICounter, IGauge, IMetricsRegistry } from './metrics';

export interface CimdDocument {
  client_id: string;
  redirect_uris: string[];
  client_name?: string;
  token_endpoint_auth_method?: string;
}

export type CimdUrlValidation =
  | { valid: true }
  | { valid: false; reason: string };

const FORBIDDEN_AUTH_METHODS = new Set([
  'client_secret_post',
  'client_secret_basic',
  'client_secret_jwt',
]);

const CIMD_MAX_RESPONSE_BYTES = 5 * 1024;
const CIMD_FETCH_TIMEOUT_MS = 5000;

/**
 * Validates a CIMD URL per draft-ietf-oauth-client-id-metadata-document Section 3.
 * Checks the raw string for dot segments before the URL constructor normalizes them.
 */
export function validateCimdUrl(url: string): CimdUrlValidation {
  // Check raw string for dot segments before URL parser normalizes them away
  const DOT_SEGMENT_RE = /(?:^|\/)\.\.(\/|$)|(?:^|\/)\.(\/|$)/;
  try {
    const rawPath = url.replace(/^https?:\/\/[^/]*/, '').split('?')[0].split('#')[0];
    if (DOT_SEGMENT_RE.test(rawPath)) {
      return { valid: false, reason: 'must not contain single-dot or double-dot path segments' };
    }
  } catch {
    // Fall through to URL parsing which will also catch invalid URLs
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, reason: 'not a valid URL' };
  }

  if (parsed.protocol !== 'https:') {
    return { valid: false, reason: 'scheme must be https' };
  }

  if (!parsed.pathname || parsed.pathname === '/') {
    return { valid: false, reason: 'must contain a path component beyond /' };
  }

  if (parsed.hash) {
    return { valid: false, reason: 'must not contain a fragment' };
  }

  if (parsed.username || parsed.password) {
    return { valid: false, reason: 'must not contain username or password' };
  }

  if (parsed.search) {
    return { valid: false, reason: 'should not contain a query string' };
  }

  return { valid: true };
}

/**
 * Returns true if client_id looks like a CIMD URL (starts with https://).
 */
export function isCimdClientId(clientId: string): boolean {
  return clientId.startsWith('https://');
}

/**
 * Resolves the upstream client_id for a CIMD URL.
 * Returns null if not found in map and no default is configured.
 */
export function resolveUpstreamClientId(
  cimdUrl: string,
  map: Record<string, string>,
  defaultClientId?: string,
): string | null {
  const mapped = map[cimdUrl];
  if (mapped !== undefined) return mapped;
  if (defaultClientId) return defaultClientId;
  return null;
}

/**
 * Validates redirect_uri against CIMD document per RFC 9700:
 * exact string match against one of the registered redirect_uris.
 */
export function validateRedirectUri(redirectUri: string, cimdDoc: CimdDocument): boolean {
  return cimdDoc.redirect_uris.includes(redirectUri);
}

/**
 * Validates the content of a fetched CIMD metadata document.
 */
export function validateCimdDocument(
  doc: Record<string, unknown>,
  expectedUrl: string,
): { valid: true; document: CimdDocument } | { valid: false; reason: string } {
  if (typeof doc.client_id !== 'string') {
    return { valid: false, reason: 'missing or non-string client_id field' };
  }

  if (doc.client_id !== expectedUrl) {
    return { valid: false, reason: 'client_id does not match the document URL' };
  }

  if (!Array.isArray(doc.redirect_uris)) {
    return { valid: false, reason: 'missing or non-array redirect_uris field' };
  }

  for (let i = 0; i < doc.redirect_uris.length; i++) {
    if (typeof doc.redirect_uris[i] !== 'string') {
      return { valid: false, reason: `redirect_uris[${i}] is not a string` };
    }
  }

  if (doc.token_endpoint_auth_method !== undefined) {
    if (typeof doc.token_endpoint_auth_method !== 'string') {
      return { valid: false, reason: 'token_endpoint_auth_method must be a string' };
    }
    if (FORBIDDEN_AUTH_METHODS.has(doc.token_endpoint_auth_method)) {
      return {
        valid: false,
        reason: `token_endpoint_auth_method "${doc.token_endpoint_auth_method}" is not allowed for CIMD clients`,
      };
    }
  }

  if (doc.client_secret !== undefined) {
    return { valid: false, reason: 'client_secret must not be present in CIMD documents' };
  }

  if (doc.client_secret_expires_at !== undefined) {
    return { valid: false, reason: 'client_secret_expires_at must not be present in CIMD documents' };
  }

  return {
    valid: true,
    document: {
      client_id: doc.client_id,
      redirect_uris: doc.redirect_uris as string[],
      client_name: typeof doc.client_name === 'string' ? doc.client_name : undefined,
      token_endpoint_auth_method: typeof doc.token_endpoint_auth_method === 'string'
        ? doc.token_endpoint_auth_method
        : undefined,
    },
  };
}

// --- SSRF Protection ---

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4) return false;
  // 10.0.0.0/8
  if (parts[0] === 10) return true;
  // 172.16.0.0/12
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  // 192.168.0.0/16
  if (parts[0] === 192 && parts[1] === 168) return true;
  // 127.0.0.0/8
  if (parts[0] === 127) return true;
  // 169.254.0.0/16
  if (parts[0] === 169 && parts[1] === 254) return true;
  // 0.0.0.0
  if (parts.every(p => p === 0)) return true;
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  // ::1 (loopback)
  if (normalized === '::1' || normalized === '0000:0000:0000:0000:0000:0000:0000:0001') return true;
  // fc00::/7 (unique local)
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  // fe80::/10 (link-local)
  if (normalized.startsWith('fe80')) return true;
  // :: (unspecified)
  if (normalized === '::' || normalized === '0000:0000:0000:0000:0000:0000:0000:0000') return true;
  // IPv6-mapped IPv4: ::ffff:x.x.x.x
  const v4MappedMatch = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4MappedMatch) {
    return isPrivateIPv4(v4MappedMatch[1]);
  }
  // Also handle full form: 0000:0000:0000:0000:0000:ffff:XXYY:ZZWW
  if (normalized.startsWith('0000:0000:0000:0000:0000:ffff:')) {
    const hexPart = normalized.slice('0000:0000:0000:0000:0000:ffff:'.length);
    const hexParts = hexPart.split(':');
    if (hexParts.length === 2) {
      const a = parseInt(hexParts[0].slice(0, 2), 16);
      const b = parseInt(hexParts[0].slice(2, 4), 16);
      const c = parseInt(hexParts[1].slice(0, 2), 16);
      const d = parseInt(hexParts[1].slice(2, 4), 16);
      return isPrivateIPv4(`${a}.${b}.${c}.${d}`);
    }
  }
  return false;
}

export function isPrivateIP(ip: string): boolean {
  if (ip.includes(':')) return isPrivateIPv6(ip);
  return isPrivateIPv4(ip);
}

/**
 * Resolves hostname and checks it doesn't point to a private IP.
 * Exported for testing.
 */
export async function validateHostNotPrivate(hostname: string): Promise<void> {
  const result = await dns.promises.lookup(hostname, { all: true });
  for (const entry of result) {
    if (isPrivateIP(entry.address)) {
      throw new Error(`CIMD URL resolves to private/reserved IP: ${entry.address}`);
    }
  }
}

function isJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const lower = contentType.toLowerCase();
  return lower.includes('application/json') || /application\/[\w.+-]+\+json/.test(lower);
}

async function readResponseWithLimit(response: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('Response has no body');
  }

  let totalBytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = result.value as Uint8Array;
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        reader.cancel().catch(() => {});
        throw new Error(`Response exceeds maximum size of ${maxBytes} bytes`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  if (chunks.length === 1) return chunks[0];
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/**
 * Fetches and validates a CIMD metadata document with full security protections.
 */
export async function fetchCimdDocument(url: string): Promise<CimdDocument> {
  const parsed = new URL(url);

  await validateHostNotPrivate(parsed.hostname);

  const response = await fetch(url, {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(CIMD_FETCH_TIMEOUT_MS),
    headers: { 'Accept': 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`CIMD metadata fetch failed: HTTP ${response.status}`);
  }

  if (!isJsonContentType(response.headers.get('content-type') ?? undefined)) {
    throw new Error('CIMD metadata response has invalid Content-Type (expected application/json)');
  }

  const bodyBuffer = await readResponseWithLimit(response, CIMD_MAX_RESPONSE_BYTES);
  const bodyText = new TextDecoder().decode(bodyBuffer);

  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    throw new Error('CIMD metadata response is not valid JSON');
  }

  const validation = validateCimdDocument(doc, url);
  if (!validation.valid) {
    throw new Error(`CIMD metadata validation failed: ${validation.reason}`);
  }

  return validation.document;
}

// --- CIMD Cache ---

interface CacheEntry {
  document: CimdDocument;
  timestamp: number;
  pinned: boolean;
}

export class CimdCache {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly pinnedUrls: Set<string>;
  private readonly maxUnpinnedSize: number;
  private readonly opsCounter: ICounter;
  private readonly evictionsCounter: ICounter;
  private readonly sizeGauge: IGauge;

  constructor(options: {
    ttlMinutes: number;
    pinnedUrls: Set<string>;
    maxUnpinnedSize?: number;
    metricsRegistry?: IMetricsRegistry;
  }) {
    this.ttlMs = options.ttlMinutes * 60 * 1000;
    this.pinnedUrls = options.pinnedUrls;
    this.maxUnpinnedSize = options.maxUnpinnedSize ?? 1000;

    const reg = options.metricsRegistry;
    if (reg) {
      this.opsCounter = reg.createCounter('mcp_auth_cimd_cache_operations_total', 'CIMD cache operations');
      this.evictionsCounter = reg.createCounter('mcp_auth_cimd_cache_evictions_total', 'CIMD cache evictions');
      this.sizeGauge = reg.createGauge('mcp_auth_cimd_cache_size', 'Current CIMD cache entry count');
    } else {
      this.opsCounter = { inc() {} };
      this.evictionsCounter = { inc() {} };
      this.sizeGauge = { set() {} };
    }
  }

  async get(url: string, fetcher: (url: string) => Promise<CimdDocument>): Promise<CimdDocument> {
    const existing = this.cache.get(url);
    if (existing && (Date.now() - existing.timestamp) < this.ttlMs) {
      this.opsCounter.inc({ result: 'hit' });
      return existing.document;
    }

    this.opsCounter.inc({ result: 'miss' });
    const document = await fetcher(url);
    const pinned = this.pinnedUrls.has(url);

    if (!pinned) {
      this.evictIfNeeded();
    }

    this.cache.set(url, { document, timestamp: Date.now(), pinned });
    this.sizeGauge.set(this.cache.size);
    return document;
  }

  private evictIfNeeded(): void {
    let unpinnedCount = 0;
    for (const entry of this.cache.values()) {
      if (!entry.pinned) unpinnedCount++;
    }

    if (unpinnedCount >= this.maxUnpinnedSize) {
      let oldestKey: string | undefined;
      let oldestTime = Infinity;
      for (const [key, entry] of this.cache.entries()) {
        if (!entry.pinned && entry.timestamp < oldestTime) {
          oldestTime = entry.timestamp;
          oldestKey = key;
        }
      }
      if (oldestKey) {
        this.cache.delete(oldestKey);
        this.evictionsCounter.inc();
        this.sizeGauge.set(this.cache.size);
      }
    }
  }

  clear(): void {
    this.cache.clear();
    this.sizeGauge.set(0);
  }

  get size(): number {
    return this.cache.size;
  }
}

// --- Output Sanitization ---

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\u0000-\u001f]/g;

/**
 * Sanitizes a user-supplied value for inclusion in error_description.
 * Truncates to maxLen and strips control characters.
 */
export function sanitizeForError(value: string, maxLen = 256): string {
  const truncated = value.length > maxLen ? value.slice(0, maxLen) + '...' : value;
  return truncated.replace(CONTROL_CHAR_RE, '');
}
