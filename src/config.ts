import { validateCimdUrl } from './cimd';
import { ParsedResourcePattern, parseResourcePatterns } from './uri-validation';

export interface ParsedClientNameEntry {
  originalPattern: string;
  normalizedPattern: string;
  isPrefix: boolean;
  clientId: string;
  allowedRedirectUris?: string[];
}

export interface AppConfig {
  baseUrl: string;
  port: number;
  upstreamSsoUrl: string;
  clientId: string;
  scopesSupported?: string[];
  authScopesRemoved?: string[];
  authScopesPreserved?: string[];
  proxyAuthEndpoint: boolean;
  proxyDcrEndpoint: boolean;
  wellKnownRefreshMinutes: number;
  debug: boolean;
  cimdMap: Record<string, string>;
  cimdDefaultClientId?: string;
  cimdCacheMinutes: number;
  cimdEnabled: boolean;
  accessLog: boolean;
  metricsEnabled: boolean;
  dpopEnabled: boolean;
  shutdownTimeoutSeconds: number;
  authStateSecret?: Buffer;
  authStateSecretPrevious?: Buffer;
  authStateTtlSeconds: number;
  allowedRedirectUris: string[];
  requireResource: boolean;
  allowedResources: ParsedResourcePattern[];
  dcrClientNameMap: ParsedClientNameEntry[];
  dcrClientIdRedirectMap: Map<string, string[]>;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseIntEnv(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || String(parsed) !== raw.trim()) {
    throw new Error(`Environment variable ${name} must be a valid integer, got: "${raw}"`);
  }
  if (parsed < min) {
    throw new Error(`Environment variable ${name} must be >= ${min}, got: ${parsed}`);
  }
  return parsed;
}

function requireUrlEnv(name: string): string {
  const raw = requireEnv(name);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Environment variable ${name} is not a valid URL: "${raw}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Environment variable ${name} must use http or https scheme, got: "${parsed.protocol}"`,
    );
  }
  return raw.replace(/\/+$/, '');
}

function parseBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw.toLowerCase() === 'true';
}

function parseScopesEnv(name: string): string[] | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const scopes = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return scopes.length > 0 ? scopes : undefined;
}

const HEX_RE = /^[0-9a-fA-F]+$/;

function parseHexSecretEnv(name: string, required: false): Buffer | undefined;
function parseHexSecretEnv(name: string, required: true): Buffer;
function parseHexSecretEnv(name: string, required: boolean): Buffer | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) {
    if (required) {
      throw new Error(
        `Missing required environment variable: ${name}. Generate with: openssl rand -hex 32`,
      );
    }
    return undefined;
  }
  if (!HEX_RE.test(raw)) {
    throw new Error(
      `${name} must be a hex-encoded string (only 0-9, a-f, A-F). Generate with: openssl rand -hex 32`,
    );
  }
  if (raw.length % 2 !== 0) {
    throw new Error(
      `${name} must have even length (complete bytes). Got ${raw.length} characters.`,
    );
  }
  const decoded = Buffer.from(raw, 'hex');
  if (decoded.length < 32) {
    throw new Error(
      `${name} must be at least 32 bytes (64 hex chars). Got ${decoded.length} bytes. Generate with: openssl rand -hex 32`,
    );
  }
  return decoded;
}

function validateRedirectUriPatterns(patterns: string[], context: string): void {
  for (const pattern of patterns) {
    const testUri = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
    if (!testUri.includes('://')) {
      throw new Error(
        `${context} contains invalid pattern "${pattern}": must include scheme (e.g. http://, https://, cursor://)`,
      );
    }
  }
}

function parseAllowedRedirectUris(name: string): string[] {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') return [];
  const patterns = raw.split(',').map((s) => s.trim()).filter(Boolean);
  validateRedirectUriPatterns(patterns, name);
  return patterns;
}

export function parseClientNameMap(envName: string): ParsedClientNameEntry[] {
  const raw = process.env[envName];
  if (!raw || raw.trim() === '') return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `${envName} is not valid JSON. Expected format: {"<client_name_pattern>": "<upstream_client_id>", ...}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `${envName} must be a JSON object mapping client_name patterns to upstream client_ids (strings or objects).`,
    );
  }

  const obj = parsed as Record<string, unknown>;
  const entries: ParsedClientNameEntry[] = [];

  for (const [key, value] of Object.entries(obj)) {
    if (!key.trim() || key.trim() === '*') {
      throw new Error(
        `${envName} contains invalid pattern key "${key}": empty, whitespace-only, or bare "*" patterns are not allowed. Use MCP_PROXY_DCR_CLIENT_ID for a catch-all.`,
      );
    }

    let clientId: string;
    let allowedRedirectUris: string[] | undefined;

    if (typeof value === 'string') {
      clientId = value;
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const entry = value as Record<string, unknown>;
      if (typeof entry.client_id !== 'string' || entry.client_id.trim() === '') {
        throw new Error(
          `${envName} entry "${key}" must have a non-empty "client_id" string.`,
        );
      }
      clientId = entry.client_id;
      if (entry.allowed_redirect_uris !== undefined) {
        if (typeof entry.allowed_redirect_uris !== 'string') {
          throw new Error(
            `${envName} entry "${key}" has invalid "allowed_redirect_uris": must be a comma-separated string.`,
          );
        }
        const patterns = entry.allowed_redirect_uris.split(',').map(s => s.trim()).filter(Boolean);
        if (patterns.length > 0) {
          validateRedirectUriPatterns(patterns, `${envName} entry "${key}"`);
          allowedRedirectUris = patterns;
        }
      }
    } else {
      throw new Error(
        `${envName} entry "${key}" must be a string (upstream client_id) or an object with "client_id". Got ${typeof value}.`,
      );
    }

    if (clientId.trim() === '') {
      throw new Error(`${envName} has empty upstream client_id for pattern "${key}"`);
    }

    const isPrefix = key.endsWith('*');
    const normalizedPattern = (isPrefix ? key.slice(0, -1) : key).toLowerCase();

    entries.push({
      originalPattern: key,
      normalizedPattern,
      isPrefix,
      clientId,
      allowedRedirectUris,
    });
  }

  return entries;
}

export function matchClientName(
  name: string | undefined,
  entries: ParsedClientNameEntry[],
): ParsedClientNameEntry | null {
  if (!name || !name.trim() || entries.length === 0) return null;

  const normalized = name.toLowerCase();

  // Exact matches first
  for (const entry of entries) {
    if (!entry.isPrefix && normalized === entry.normalizedPattern) {
      return entry;
    }
  }

  // Prefix matches in declaration order
  for (const entry of entries) {
    if (entry.isPrefix && normalized.startsWith(entry.normalizedPattern)) {
      return entry;
    }
  }

  return null;
}

export function buildClientIdRedirectMap(
  entries: ParsedClientNameEntry[],
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const entry of entries) {
    if (!entry.allowedRedirectUris || entry.allowedRedirectUris.length === 0) continue;
    const existing = map.get(entry.clientId);
    if (existing) {
      for (const uri of entry.allowedRedirectUris) {
        if (!existing.includes(uri)) existing.push(uri);
      }
    } else {
      map.set(entry.clientId, [...entry.allowedRedirectUris]);
    }
  }
  return map;
}

function parseAllowedResources(name: string): string[] {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') return [];
  const patterns = raw.split(',').map((s) => s.trim()).filter(Boolean);
  for (const pattern of patterns) {
    let testUri = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
    // Domain wildcard: https://*.example.com/... → replace *. for scheme validation
    testUri = testUri.replace('://*.', '://wildcard-placeholder.');
    if (!testUri.startsWith('https://') && !testUri.startsWith('http://')) {
      throw new Error(
        `${name} contains invalid pattern "${pattern}": must use http:// or https:// scheme (RFC 8707)`,
      );
    }
    // Reject bare wildcard host (https://*/* or https://*) — must be *.domain
    const hostMatch = pattern.match(/^https?:\/\/([^/:]+)/);
    if (hostMatch && (hostMatch[1] === '*' || hostMatch[1] === '*.')) {
      throw new Error(
        `${name} contains invalid pattern "${pattern}": wildcard host must include a base domain (e.g. *.example.com), bare * is not allowed`,
      );
    }
  }
  return patterns;
}

function parseCimdMap(name: string): Record<string, string> {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `${name} is not valid JSON. Expected format: {"<cimd_url>": "<upstream_client_id>", ...}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `${name} must be a JSON object mapping CIMD URLs (strings) to upstream client_ids (strings).`,
    );
  }

  const obj = parsed as Record<string, unknown>;
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value !== 'string') {
      throw new Error(
        `${name} must be a JSON object mapping CIMD URLs (strings) to upstream client_ids (strings). Got non-string value for key "${key}".`,
      );
    }
    if (value.trim() === '') {
      throw new Error(`${name} has empty upstream client_id for CIMD URL "${key}"`);
    }
    const urlValidation = validateCimdUrl(key);
    if (!urlValidation.valid) {
      throw new Error(
        `${name} contains invalid CIMD URL "${key}": ${urlValidation.reason}`,
      );
    }
    result[key] = value;
  }

  return result;
}

export function loadConfig(): AppConfig {
  const clientId = process.env.MCP_PROXY_DCR_CLIENT_ID?.trim() || undefined;

  const dcrClientNameMap = parseClientNameMap('MCP_PROXY_DCR_CLIENT_NAME_MAP');
  const dcrClientIdRedirectMap = buildClientIdRedirectMap(dcrClientNameMap);

  // Security #4: error if any entry with allowedRedirectUris has clientId == fallback
  if (clientId) {
    for (const entry of dcrClientNameMap) {
      if (entry.allowedRedirectUris && entry.clientId === clientId) {
        throw new Error(
          `MCP_PROXY_DCR_CLIENT_NAME_MAP entry "${entry.originalPattern}" has client_id "${entry.clientId}" ` +
          `which equals MCP_PROXY_DCR_CLIENT_ID. This would apply per-client redirect restrictions to all ` +
          `fallback clients. Use a different client_id or remove allowed_redirect_uris from this entry.`,
        );
      }
    }
  }

  const proxyDcrEndpoint = clientId !== undefined || dcrClientNameMap.length > 0;

  const cimdMap = parseCimdMap('MCP_PROXY_CIMD_MAP');
  const cimdDefaultClientId = process.env.MCP_PROXY_CIMD_DEFAULT_CLIENT_ID?.trim() || undefined;
  const cimdCacheMinutes = parseIntEnv('MCP_PROXY_CIMD_CACHE_MINUTES', 30);
  const cimdEnabled = Object.keys(cimdMap).length > 0 || cimdDefaultClientId !== undefined;
  const authScopesRemoved = parseScopesEnv('MCP_PROXY_AUTH_SCOPES_REMOVED');
  const authScopesPreserved = parseScopesEnv('MCP_PROXY_AUTH_SCOPES_PRESERVED');

  // Parse state secret early to determine proxyAuthEndpoint activation
  const hasStateSecret = !!process.env.MCP_PROXY_AUTH_STATE_SECRET?.trim();

  // /authorize proxy auto-enables when any feature that needs it is configured
  const proxyAuthEndpoint = cimdEnabled
    || authScopesRemoved !== undefined
    || authScopesPreserved !== undefined
    || hasStateSecret;

  // State secret is required when authorize proxy is active
  let authStateSecret: Buffer | undefined;
  if (proxyAuthEndpoint) {
    authStateSecret = parseHexSecretEnv('MCP_PROXY_AUTH_STATE_SECRET', true);
  }

  const authStateSecretPrevious = parseHexSecretEnv('MCP_PROXY_AUTH_STATE_SECRET_PREVIOUS', false);
  const authStateTtlMinutes = parseIntEnv('MCP_PROXY_AUTH_STATE_TTL_MINUTES', 30, 1);

  const allowedRedirectUris = parseAllowedRedirectUris('MCP_PROXY_AUTH_ALLOWED_REDIRECT_URIS');

  // Global redirect URIs not needed when:
  // - CIMD-only (CIMD validates redirect URIs via metadata docs)
  // - All DCR map entries have per-client patterns AND no fallback client_id
  const cimdOnly = cimdEnabled && !proxyDcrEndpoint;
  const allDcrEntriesCovered = dcrClientNameMap.length > 0
    && dcrClientNameMap.every(e => e.allowedRedirectUris && e.allowedRedirectUris.length > 0)
    && !clientId;
  const globalRedirectUrisNotNeeded = cimdOnly || allDcrEntriesCovered;
  if (proxyAuthEndpoint && allowedRedirectUris.length === 0 && !globalRedirectUrisNotNeeded) {
    throw new Error(
      'MCP_PROXY_AUTH_ALLOWED_REDIRECT_URIS is required when the authorize proxy is active. ' +
      'Specify comma-separated allowed redirect URI patterns (trailing * for prefix match).',
    );
  }

  // Warn if per-client redirect patterns configured but auth proxy not active
  if (!proxyAuthEndpoint && dcrClientIdRedirectMap.size > 0) {
    console.warn(
      'Warning: MCP_PROXY_DCR_CLIENT_NAME_MAP entries have allowed_redirect_uris but the ' +
      'authorize proxy is not active — per-client redirect patterns will not be enforced.',
    );
  }

  return {
    baseUrl: requireUrlEnv('MCP_BASE_URL'),
    port: parseIntEnv('MCP_PORT', 3000, 1),
    upstreamSsoUrl: requireUrlEnv('MCP_UPSTREAM_SSO_URL'),
    clientId: clientId ?? '',
    scopesSupported: parseScopesEnv('MCP_WELL_KNOWN_SCOPES_SUPPORTED'),
    authScopesRemoved,
    authScopesPreserved,
    proxyAuthEndpoint,
    proxyDcrEndpoint,
    wellKnownRefreshMinutes: parseIntEnv('MCP_WELL_KNOWN_REFRESH_MINUTES', 60),
    debug: parseBoolEnv('MCP_DEBUG', false),
    cimdMap,
    cimdDefaultClientId,
    cimdCacheMinutes,
    cimdEnabled,
    accessLog: parseBoolEnv('MCP_ACCESS_LOG', true),
    metricsEnabled: parseBoolEnv('MCP_METRICS_ENABLED', true),
    dpopEnabled: parseBoolEnv('MCP_PROXY_DPOP_ENABLED', false),
    shutdownTimeoutSeconds: parseIntEnv('MCP_SHUTDOWN_TIMEOUT_SECONDS', 30),
    authStateSecret,
    authStateSecretPrevious,
    authStateTtlSeconds: authStateTtlMinutes * 60,
    allowedRedirectUris,
    requireResource: parseBoolEnv('MCP_PROXY_AUTH_REQUIRE_RESOURCE', false),
    allowedResources: parseResourcePatterns(parseAllowedResources('MCP_PROXY_AUTH_ALLOWED_RESOURCES')),
    dcrClientNameMap,
    dcrClientIdRedirectMap,
  };
}
