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

  // /authorize proxy auto-enables when any feature that needs it is configured
  const proxyAuthEndpoint = cimdEnabled
    || authScopesRemoved !== undefined
    || authScopesPreserved !== undefined;

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
  };
}
