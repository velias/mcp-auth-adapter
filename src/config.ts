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
  metricsEnabled: boolean;
  shutdownTimeoutSeconds: number;
  authStateSecret?: Buffer;
  authStateSecretPrevious?: Buffer;
  authStateTtlSeconds: number;
  allowedRedirectUris: string[];
  requireResource: boolean;
  allowedResources: string[];
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

function parseAllowedRedirectUris(name: string): string[] {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') return [];
  const patterns = raw.split(',').map((s) => s.trim()).filter(Boolean);
  for (const pattern of patterns) {
    const testUri = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
    if (!testUri.includes('://')) {
      throw new Error(
        `${name} contains invalid pattern "${pattern}": must include scheme (e.g. http://, https://, cursor://)`,
      );
    }
  }
  return patterns;
}

function parseAllowedResources(name: string): string[] {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') return [];
  const patterns = raw.split(',').map((s) => s.trim()).filter(Boolean);
  for (const pattern of patterns) {
    const testUri = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
    if (!testUri.startsWith('https://') && !testUri.startsWith('http://')) {
      throw new Error(
        `${name} contains invalid pattern "${pattern}": must use http:// or https:// scheme (RFC 8707)`,
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

  // Import validateCimdUrl lazily to keep the module dependency clean
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { validateCimdUrl } = require('./cimd') as { validateCimdUrl: (url: string) => { valid: boolean; reason?: string } };

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
  const proxyDcrEndpoint = clientId !== undefined;

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

  // Require allowed redirect URIs when authorize proxy is active unless CIMD-only
  // (CIMD-only = CIMD enabled without DCR; CIMD validates redirect URIs via metadata docs)
  const cimdOnly = cimdEnabled && !proxyDcrEndpoint;
  if (proxyAuthEndpoint && allowedRedirectUris.length === 0 && !cimdOnly) {
    throw new Error(
      'MCP_PROXY_AUTH_ALLOWED_REDIRECT_URIS is required when the authorize proxy is active. ' +
      'Specify comma-separated allowed redirect URI patterns (trailing * for prefix match).',
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
    metricsEnabled: parseBoolEnv('MCP_METRICS_ENABLED', true),
    shutdownTimeoutSeconds: parseIntEnv('MCP_SHUTDOWN_TIMEOUT_SECONDS', 30),
    authStateSecret,
    authStateSecretPrevious,
    authStateTtlSeconds: authStateTtlMinutes * 60,
    allowedRedirectUris,
    requireResource: parseBoolEnv('MCP_PROXY_AUTH_REQUIRE_RESOURCE', false),
    allowedResources: parseAllowedResources('MCP_PROXY_AUTH_ALLOWED_RESOURCES'),
  };
}
