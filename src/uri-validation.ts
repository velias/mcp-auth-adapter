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
