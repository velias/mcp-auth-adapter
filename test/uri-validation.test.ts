import { validateRedirectUriSecurity, matchesRedirectPattern, validateResourceUri, matchesResourcePattern, matchedResourcePattern, checkResourceParam, parseResourcePatterns } from '../src/uri-validation';

const p = parseResourcePatterns;

describe('validateRedirectUriSecurity', () => {
  it('accepts a valid http URI', () => {
    const result = validateRedirectUriSecurity('http://localhost:8080/callback');
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.parsed.href).toBe('http://localhost:8080/callback');
  });

  it('accepts a valid https URI', () => {
    const result = validateRedirectUriSecurity('https://example.com/auth/callback');
    expect(result.valid).toBe(true);
  });

  it('accepts custom scheme URIs (cursor://)', () => {
    const result = validateRedirectUriSecurity('cursor://anysphere.cursor-mcp/callback');
    expect(result.valid).toBe(true);
  });

  it('accepts vscode custom scheme', () => {
    const result = validateRedirectUriSecurity('vscode://saoudrizwan.claude-dev/oauth');
    expect(result.valid).toBe(true);
  });

  it('rejects URI with fragment', () => {
    const result = validateRedirectUriSecurity('http://localhost:8080/cb#frag');
    expect(result).toEqual({ valid: false, reason: 'must not contain a fragment' });
  });

  it('rejects unparseable URI', () => {
    const result = validateRedirectUriSecurity('not-a-url');
    expect(result).toEqual({ valid: false, reason: 'not a valid URI' });
  });

  it('rejects empty string', () => {
    const result = validateRedirectUriSecurity('');
    expect(result).toEqual({ valid: false, reason: 'not a valid URI' });
  });

  it('rejects URI with username userinfo', () => {
    const result = validateRedirectUriSecurity('http://user@host.com/callback');
    expect(result).toEqual({ valid: false, reason: 'must not contain userinfo' });
  });

  it('rejects URI with user:pass userinfo', () => {
    const result = validateRedirectUriSecurity('http://user:pass@host.com/callback');
    expect(result).toEqual({ valid: false, reason: 'must not contain userinfo' });
  });

  it('rejects URI with localhost@evil.com userinfo attack', () => {
    const result = validateRedirectUriSecurity('http://localhost:8080@evil.com/callback');
    expect(result).toEqual({ valid: false, reason: 'must not contain userinfo' });
  });

  it('rejects URI with CRLF control characters', () => {
    const result = validateRedirectUriSecurity('http://localhost/\r\ninjection');
    expect(result).toEqual({ valid: false, reason: 'contains control characters' });
  });

  it('rejects URI with null byte', () => {
    const result = validateRedirectUriSecurity('http://localhost/\x00');
    expect(result).toEqual({ valid: false, reason: 'contains control characters' });
  });

  it('rejects URI with tab character', () => {
    const result = validateRedirectUriSecurity('http://localhost/\tcallback');
    expect(result).toEqual({ valid: false, reason: 'contains control characters' });
  });
});

describe('matchesRedirectPattern', () => {
  const PATTERNS = [
    'http://localhost:*',
    'http://127.0.0.1:*',
    'https://claude.ai/api/mcp/auth_callback',
    'cursor://anysphere.cursor-mcp/*',
  ];

  it('matches trailing wildcard prefix (http://localhost:8080/cb)', () => {
    const result = matchesRedirectPattern('http://localhost:8080/callback', PATTERNS);
    expect(result).toEqual({ allowed: true });
  });

  it('matches exact pattern', () => {
    const result = matchesRedirectPattern('https://claude.ai/api/mcp/auth_callback', PATTERNS);
    expect(result).toEqual({ allowed: true });
  });

  it('matches custom scheme wildcard', () => {
    const result = matchesRedirectPattern('cursor://anysphere.cursor-mcp/oauth/redirect', PATTERNS);
    expect(result).toEqual({ allowed: true });
  });

  it('rejects URI not matching any pattern', () => {
    const result = matchesRedirectPattern('https://evil.com/steal', PATTERNS);
    expect(result).toEqual({ allowed: false, reason: 'no matching pattern' });
  });

  it('applies security pre-checks (rejects fragment)', () => {
    const result = matchesRedirectPattern('http://localhost:8080/cb#frag', PATTERNS);
    expect(result).toEqual({ allowed: false, reason: 'must not contain a fragment' });
  });

  it('applies security pre-checks (rejects userinfo)', () => {
    const result = matchesRedirectPattern('http://localhost:8080@evil.com/', PATTERNS);
    expect(result).toEqual({ allowed: false, reason: 'must not contain userinfo' });
  });

  it('rejects when patterns list is empty', () => {
    const result = matchesRedirectPattern('http://localhost:8080/cb', []);
    expect(result).toEqual({ allowed: false, reason: 'no matching pattern' });
  });

  it('matches various port numbers', () => {
    expect(matchesRedirectPattern('http://localhost:3000/', PATTERNS)).toEqual({ allowed: true });
    expect(matchesRedirectPattern('http://localhost:9999/x', PATTERNS)).toEqual({ allowed: true });
    expect(matchesRedirectPattern('http://127.0.0.1:5000/oauth', PATTERNS)).toEqual({ allowed: true });
  });

  it('does not match partial scheme (http:// vs https://)', () => {
    const result = matchesRedirectPattern('https://localhost:8080/cb', PATTERNS);
    expect(result).toEqual({ allowed: false, reason: 'no matching pattern' });
  });
});

describe('validateResourceUri', () => {
  it('accepts valid https URI', () => {
    const result = validateResourceUri('https://mcp.example.com/mcp');
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.parsed.href).toBe('https://mcp.example.com/mcp');
  });

  it('accepts valid https URI without path', () => {
    const result = validateResourceUri('https://mcp.example.com');
    expect(result.valid).toBe(true);
  });

  it('accepts valid https URI with port', () => {
    const result = validateResourceUri('https://mcp.example.com:8443');
    expect(result.valid).toBe(true);
  });

  it('accepts http for dev (http://localhost:3000/mcp)', () => {
    const result = validateResourceUri('http://localhost:3000/mcp');
    expect(result.valid).toBe(true);
  });

  it('rejects custom schemes (cursor://)', () => {
    const result = validateResourceUri('cursor://anysphere.cursor-mcp/resource');
    expect(result).toEqual({ valid: false, reason: 'must use http or https scheme' });
  });

  it('rejects custom schemes (vscode://)', () => {
    const result = validateResourceUri('vscode://saoudrizwan.claude-dev/resource');
    expect(result).toEqual({ valid: false, reason: 'must use http or https scheme' });
  });

  it('rejects URI with fragment', () => {
    const result = validateResourceUri('https://mcp.example.com#frag');
    expect(result).toEqual({ valid: false, reason: 'must not contain a fragment' });
  });

  it('rejects URI with userinfo', () => {
    const result = validateResourceUri('https://user:pass@mcp.example.com/mcp');
    expect(result).toEqual({ valid: false, reason: 'must not contain userinfo' });
  });

  it('rejects unparseable string', () => {
    const result = validateResourceUri('not-a-url');
    expect(result).toEqual({ valid: false, reason: 'not a valid URI' });
  });

  it('rejects empty string', () => {
    const result = validateResourceUri('');
    expect(result).toEqual({ valid: false, reason: 'not a valid URI' });
  });

  it('rejects control characters', () => {
    const result = validateResourceUri('https://mcp.example.com/\x00');
    expect(result).toEqual({ valid: false, reason: 'contains control characters' });
  });
});

describe('matchesResourcePattern', () => {
  it('matches exact host + exact path', () => {
    expect(matchesResourcePattern('https://api.example.com/mcp', p(['https://api.example.com/mcp'])))
      .toEqual({ allowed: true });
  });

  it('matches exact host + trailing * path prefix', () => {
    expect(matchesResourcePattern('https://api.example.com/v1/tools', p(['https://api.example.com/*'])))
      .toEqual({ allowed: true });
  });

  it('*.example.com matches example.com (bare domain)', () => {
    expect(matchesResourcePattern('https://example.com/api', p(['https://*.example.com/*'])))
      .toEqual({ allowed: true });
  });

  it('*.example.com matches sub.example.com (single subdomain)', () => {
    expect(matchesResourcePattern('https://sub.example.com/api', p(['https://*.example.com/*'])))
      .toEqual({ allowed: true });
  });

  it('*.example.com matches a.b.example.com (multi-level subdomain)', () => {
    expect(matchesResourcePattern('https://a.b.example.com/api', p(['https://*.example.com/*'])))
      .toEqual({ allowed: true });
  });

  it('*.example.com does NOT match notexample.com (suffix attack)', () => {
    expect(matchesResourcePattern('https://notexample.com/api', p(['https://*.example.com/*'])))
      .toEqual({ allowed: false, reason: 'no matching pattern' });
  });

  it('*.example.com does NOT match fakeexample.com (no dot boundary)', () => {
    expect(matchesResourcePattern('https://fakeexample.com/api', p(['https://*.example.com/*'])))
      .toEqual({ allowed: false, reason: 'no matching pattern' });
  });

  it('domain wildcard + path prefix combined', () => {
    expect(matchesResourcePattern('https://sub.example.com/api/v1', p(['https://*.example.com/api/*'])))
      .toEqual({ allowed: true });
  });

  it('domain wildcard without trailing * matches exact path', () => {
    expect(matchesResourcePattern('https://sub.example.com/', p(['https://*.example.com'])))
      .toEqual({ allowed: true });
  });

  it('domain wildcard with specific path (no trailing *) matches exact path', () => {
    expect(matchesResourcePattern('https://sub.example.com/api/v1', p(['https://*.example.com/api/v1'])))
      .toEqual({ allowed: true });
  });

  it('domain wildcard with exact path rejects different path', () => {
    expect(matchesResourcePattern('https://sub.example.com/other', p(['https://*.example.com/api/v1'])))
      .toEqual({ allowed: false, reason: 'no matching pattern' });
  });

  it('rejects scheme mismatch (http vs https)', () => {
    expect(matchesResourcePattern('http://sub.example.com/api', p(['https://*.example.com/*'])))
      .toEqual({ allowed: false, reason: 'no matching pattern' });
  });

  it('applies security pre-checks (fragment)', () => {
    expect(matchesResourcePattern('https://example.com/api#frag', p(['https://*.example.com/*'])))
      .toEqual({ allowed: false, reason: 'must not contain a fragment' });
  });

  it('applies security pre-checks (userinfo)', () => {
    expect(matchesResourcePattern('https://user@example.com/api', p(['https://*.example.com/*'])))
      .toEqual({ allowed: false, reason: 'must not contain userinfo' });
  });

  it('applies security pre-checks (control chars)', () => {
    expect(matchesResourcePattern('https://example.com/\x00api', p(['https://*.example.com/*'])))
      .toEqual({ allowed: false, reason: 'contains control characters' });
  });

  it('rejects custom scheme', () => {
    expect(matchesResourcePattern('cursor://example.com/api', p(['cursor://*.example.com/*'])))
      .toEqual({ allowed: false, reason: 'must use http or https scheme' });
  });
});

describe('matchedResourcePattern', () => {
  it('returns the matched pattern string', () => {
    expect(matchedResourcePattern('https://api.example.com/v1', p(['https://api.example.com/*'])))
      .toBe('https://api.example.com/*');
  });

  it('returns empty string when resource is empty', () => {
    expect(matchedResourcePattern('', p(['https://api.example.com/*']))).toBe('');
  });

  it('returns empty string when allowlist is empty', () => {
    expect(matchedResourcePattern('https://api.example.com/v1', p([]))).toBe('');
  });

  it('returns empty string when no pattern matches', () => {
    expect(matchedResourcePattern('https://other.com/v1', p(['https://api.example.com/*']))).toBe('');
  });

  it('returns the first matching pattern with domain wildcard', () => {
    expect(matchedResourcePattern('https://sub.example.com/api', p(['https://*.example.com/*'])))
      .toBe('https://*.example.com/*');
  });
});

describe('checkResourceParam (structured return)', () => {
  it('returns null when validation passes', () => {
    expect(checkResourceParam('https://mcp.example.com', { requireResource: false, allowedResources: [] }))
      .toBeNull();
  });

  it('returns resource_required reason when missing and required', () => {
    const result = checkResourceParam('', { requireResource: true, allowedResources: [] });
    expect(result).toEqual({
      description: 'resource parameter is required (RFC 8707)',
      reason: 'resource_required',
    });
  });

  it('returns resource_invalid reason for bad URI', () => {
    const result = checkResourceParam('cursor://foo/bar', { requireResource: false, allowedResources: [] });
    expect(result).toEqual({
      description: 'resource parameter must be a valid HTTPS URI without fragment',
      reason: 'resource_invalid',
    });
  });

  it('returns resource_not_allowed reason when not in allowlist', () => {
    const result = checkResourceParam('https://other.com/api', {
      requireResource: false,
      allowedResources: p(['https://mcp.example.com/*']),
    });
    expect(result).toEqual({
      description: 'resource not allowed',
      reason: 'resource_not_allowed',
    });
  });

  it('passes when resource matches allowlist with domain wildcard', () => {
    expect(checkResourceParam('https://sub.example.com/api', {
      requireResource: false,
      allowedResources: p(['https://*.example.com/*']),
    })).toBeNull();
  });
});
