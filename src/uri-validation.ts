// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

export type UriSecurityResult =
  | { valid: true; parsed: URL }
  | { valid: false; reason: string };

/**
 * Validates a redirect URI for security issues common to all OAuth flows.
 * Checks: parseability, fragment presence, control characters, userinfo.
 * Does NOT enforce scheme restrictions (custom/private-use schemes are valid per RFC 8252 §7.1).
 */
export function validateRedirectUriSecurity(uri: string): UriSecurityResult {
  if (CONTROL_CHAR_RE.test(uri)) {
    return { valid: false, reason: 'contains control characters' };
  }

  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return { valid: false, reason: 'not a valid URI' };
  }

  if (parsed.hash) {
    return { valid: false, reason: 'must not contain a fragment' };
  }

  if (parsed.username || parsed.password) {
    return { valid: false, reason: 'must not contain userinfo' };
  }

  return { valid: true, parsed };
}

export type PatternMatchResult =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Validates a resource URI per RFC 8707 Section 2: must be an absolute URI
 * with http or https scheme, no fragment, no userinfo, no control characters.
 */
export function validateResourceUri(uri: string): UriSecurityResult {
  const result = validateRedirectUriSecurity(uri);
  if (!result.valid) return result;
  if (result.parsed.protocol !== 'https:' && result.parsed.protocol !== 'http:') {
    return { valid: false, reason: 'must use http or https scheme' };
  }
  return result;
}

/**
 * Validates a redirect URI against a list of allowed patterns.
 * Applies security pre-checks first, then matches against patterns.
 * Pattern format: trailing `*` = prefix match, otherwise exact match.
 */
export function matchesRedirectPattern(uri: string, patterns: string[]): PatternMatchResult {
  const securityCheck = validateRedirectUriSecurity(uri);
  if (!securityCheck.valid) {
    return { allowed: false, reason: securityCheck.reason };
  }

  for (const pattern of patterns) {
    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1);
      if (uri.startsWith(prefix)) {
        return { allowed: true };
      }
    } else {
      if (uri === pattern) {
        return { allowed: true };
      }
    }
  }

  return { allowed: false, reason: 'no matching pattern' };
}

export interface ParsedResourcePattern {
  original: string;
  protocol: string;
  hostname: string;
  isDomainWildcard: boolean;
  baseDomain: string;
  port: string;
  isPathWildcard: boolean;
  pathname: string;
}

/**
 * Pre-parses resource allowlist patterns at config time so runtime matching
 * is pure field comparison with no URL construction.
 */
export function parseResourcePatterns(patterns: string[]): ParsedResourcePattern[] {
  const result: ParsedResourcePattern[] = [];
  for (const pattern of patterns) {
    const isPathWildcard = pattern.endsWith('*');
    const stripped = isPathWildcard ? pattern.slice(0, -1) : pattern;
    let patternUrl: URL;
    try {
      patternUrl = new URL(stripped.endsWith('/') ? stripped : stripped + '/');
    } catch {
      continue;
    }

    const hostname = patternUrl.hostname;
    const isDomainWildcard = hostname.startsWith('*.');

    let pathname: string;
    if (isPathWildcard) {
      const prefix = pattern.slice(0, -1);
      const prefixUrl = new URL(prefix.endsWith('/') ? prefix : prefix + '/');
      pathname = prefixUrl.pathname;
    } else {
      pathname = patternUrl.pathname;
    }

    result.push({
      original: pattern,
      protocol: patternUrl.protocol,
      hostname,
      isDomainWildcard,
      baseDomain: isDomainWildcard ? hostname.slice(2) : '',
      port: patternUrl.port,
      isPathWildcard,
      pathname,
    });
  }
  return result;
}

export interface ResourceConfig {
  requireResource: boolean;
  allowedResources: ParsedResourcePattern[];
}

export type ResourceCheckFailure = {
  description: string;
  reason: 'resource_required' | 'resource_invalid' | 'resource_not_allowed';
};

function matchesSinglePattern(parsed: URL, rawUri: string, p: ParsedResourcePattern): boolean {
  if (parsed.protocol !== p.protocol) return false;

  if (p.isDomainWildcard) {
    if (parsed.hostname !== p.baseDomain && !parsed.hostname.endsWith('.' + p.baseDomain)) return false;
  } else {
    if (parsed.hostname !== p.hostname) return false;
  }

  if (p.port && parsed.port !== p.port) return false;

  if (p.isPathWildcard) {
    return parsed.pathname.startsWith(p.pathname) || parsed.pathname + '/' === p.pathname;
  } else if (p.isDomainWildcard) {
    return parsed.pathname === p.pathname || parsed.pathname + '/' === p.pathname;
  } else {
    return rawUri === p.original;
  }
}

/**
 * Matches a resource URI against pre-parsed allowed patterns.
 * Pattern host `*.example.com` matches `example.com` and any subdomain.
 * Trailing `*` in path = prefix match, otherwise exact match.
 */
export function matchesResourcePattern(uri: string, patterns: ParsedResourcePattern[]): PatternMatchResult {
  const securityCheck = validateResourceUri(uri);
  if (!securityCheck.valid) {
    return { allowed: false, reason: securityCheck.reason };
  }

  for (const p of patterns) {
    if (matchesSinglePattern(securityCheck.parsed, uri, p)) return { allowed: true };
  }

  return { allowed: false, reason: 'no matching pattern' };
}

/**
 * Returns the first matching resource allowlist pattern for use as a metrics label.
 * Returns empty string when no match or resource is empty.
 * Validates the input URI once and iterates pre-parsed patterns.
 */
export function matchedResourcePattern(resource: string, allowedResources: ParsedResourcePattern[]): string {
  if (!resource || allowedResources.length === 0) return '';

  const securityCheck = validateResourceUri(resource);
  if (!securityCheck.valid) return '';

  for (const p of allowedResources) {
    if (matchesSinglePattern(securityCheck.parsed, resource, p)) return p.original;
  }
  return '';
}

export interface ResourceCheckResult {
  error: ResourceCheckFailure | null;
  matchedPattern: string;
}

/**
 * Validates the RFC 8707 resource parameter and returns the matched allowlist
 * pattern in a single pass (one URL parse). Combines the work of
 * checkResourceParam + matchedResourcePattern to avoid duplicate parsing.
 */
export function checkAndMatchResource(resource: string, config: ResourceConfig): ResourceCheckResult {
  if (config.requireResource && !resource) {
    return {
      error: { description: 'resource parameter is required (RFC 8707)', reason: 'resource_required' },
      matchedPattern: '',
    };
  }
  if (!resource) return { error: null, matchedPattern: '' };

  const uriCheck = validateResourceUri(resource);
  if (!uriCheck.valid) {
    return {
      error: { description: 'resource parameter must be a valid HTTPS URI without fragment', reason: 'resource_invalid' },
      matchedPattern: '',
    };
  }

  if (config.allowedResources.length > 0) {
    const p = config.allowedResources.find(pat => matchesSinglePattern(uriCheck.parsed, resource, pat));
    if (!p) {
      return {
        error: { description: 'resource not allowed', reason: 'resource_not_allowed' },
        matchedPattern: '',
      };
    }
    return { error: null, matchedPattern: p.original };
  }

  return { error: null, matchedPattern: '' };
}

/**
 * Validates the RFC 8707 resource parameter (three layers: require, format, allowlist).
 * Validates the URI once and reuses the parsed URL for allowlist matching.
 */
export function checkResourceParam(resource: string, config: ResourceConfig): ResourceCheckFailure | null {
  if (config.requireResource && !resource) {
    return { description: 'resource parameter is required (RFC 8707)', reason: 'resource_required' };
  }

  if (resource) {
    const uriCheck = validateResourceUri(resource);
    if (!uriCheck.valid) {
      return { description: 'resource parameter must be a valid HTTPS URI without fragment', reason: 'resource_invalid' };
    }

    if (config.allowedResources.length > 0) {
      const matched = config.allowedResources.some(p => matchesSinglePattern(uriCheck.parsed, resource, p));
      if (!matched) {
        return { description: 'resource not allowed', reason: 'resource_not_allowed' };
      }
    }
  }

  return null;
}
