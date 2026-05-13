import {
  validateCimdUrl,
  isCimdClientId,
  resolveUpstreamClientId,
  validateCimdDocument,
  validateRedirectUri,
  isPrivateIP,
  CimdCache,
  CimdDocument,
  sanitizeForError,
} from '../src/cimd';

describe('validateCimdUrl', () => {
  it('accepts a valid CIMD URL', () => {
    expect(validateCimdUrl('https://cursor.com/oauth-client.json')).toEqual({ valid: true });
  });

  it('accepts URL with port', () => {
    expect(validateCimdUrl('https://cursor.com:8443/oauth-client.json')).toEqual({ valid: true });
  });

  it('rejects non-https scheme', () => {
    const result = validateCimdUrl('http://cursor.com/oauth-client.json');
    expect(result).toEqual({ valid: false, reason: 'scheme must be https' });
  });

  it('rejects URL without path beyond /', () => {
    const result = validateCimdUrl('https://cursor.com/');
    expect(result).toEqual({ valid: false, reason: 'must contain a path component beyond /' });
  });

  it('rejects URL with no path at all', () => {
    const result = validateCimdUrl('https://cursor.com');
    expect(result).toEqual({ valid: false, reason: 'must contain a path component beyond /' });
  });

  it('rejects URL with single-dot path segment', () => {
    const result = validateCimdUrl('https://cursor.com/./oauth-client.json');
    expect(result).toEqual({ valid: false, reason: 'must not contain single-dot or double-dot path segments' });
  });

  it('rejects URL with double-dot path segment', () => {
    const result = validateCimdUrl('https://cursor.com/../secret/oauth-client.json');
    expect(result).toEqual({ valid: false, reason: 'must not contain single-dot or double-dot path segments' });
  });

  it('rejects URL with fragment', () => {
    const result = validateCimdUrl('https://cursor.com/oauth-client.json#section');
    expect(result).toEqual({ valid: false, reason: 'must not contain a fragment' });
  });

  it('rejects URL with username', () => {
    const result = validateCimdUrl('https://user@cursor.com/oauth-client.json');
    expect(result).toEqual({ valid: false, reason: 'must not contain username or password' });
  });

  it('rejects URL with username and password', () => {
    const result = validateCimdUrl('https://user:pass@cursor.com/oauth-client.json');
    expect(result).toEqual({ valid: false, reason: 'must not contain username or password' });
  });

  it('rejects URL with query string', () => {
    const result = validateCimdUrl('https://cursor.com/oauth-client.json?version=2');
    expect(result).toEqual({ valid: false, reason: 'should not contain a query string' });
  });

  it('rejects invalid URL', () => {
    const result = validateCimdUrl('not-a-url');
    expect(result).toEqual({ valid: false, reason: 'not a valid URL' });
  });

  it('accepts deep path', () => {
    expect(validateCimdUrl('https://cursor.com/.well-known/oauth-client.json')).toEqual({ valid: true });
  });
});

describe('isCimdClientId', () => {
  it('returns true for https URL', () => {
    expect(isCimdClientId('https://cursor.com/oauth-client.json')).toBe(true);
  });

  it('returns false for plain string', () => {
    expect(isCimdClientId('my-client-id')).toBe(false);
  });

  it('returns false for http URL', () => {
    expect(isCimdClientId('http://cursor.com/oauth-client.json')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isCimdClientId('')).toBe(false);
  });
});

describe('resolveUpstreamClientId', () => {
  const map = {
    'https://cursor.com/oauth.json': 'cursor-client',
    'https://claude.ai/oauth.json': 'claude-client',
  };

  it('returns mapped client_id for known URL', () => {
    expect(resolveUpstreamClientId('https://cursor.com/oauth.json', map)).toBe('cursor-client');
  });

  it('returns default when URL not in map', () => {
    expect(resolveUpstreamClientId('https://unknown.com/oauth.json', map, 'default-client'))
      .toBe('default-client');
  });

  it('returns null when URL not in map and no default', () => {
    expect(resolveUpstreamClientId('https://unknown.com/oauth.json', map)).toBeNull();
  });

  it('prefers map over default', () => {
    expect(resolveUpstreamClientId('https://cursor.com/oauth.json', map, 'default-client'))
      .toBe('cursor-client');
  });
});

describe('validateCimdDocument', () => {
  const url = 'https://cursor.com/oauth-client.json';

  it('accepts valid document', () => {
    const result = validateCimdDocument({
      client_id: url,
      redirect_uris: ['http://127.0.0.1:8080/callback'],
      client_name: 'Cursor',
    }, url);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.document.client_id).toBe(url);
      expect(result.document.redirect_uris).toEqual(['http://127.0.0.1:8080/callback']);
      expect(result.document.client_name).toBe('Cursor');
    }
  });

  it('rejects missing client_id', () => {
    const result = validateCimdDocument({
      redirect_uris: ['http://127.0.0.1:8080/callback'],
    }, url);
    expect(result).toEqual({ valid: false, reason: 'missing or non-string client_id field' });
  });

  it('rejects client_id mismatch', () => {
    const result = validateCimdDocument({
      client_id: 'https://different.com/oauth.json',
      redirect_uris: ['http://127.0.0.1:8080/callback'],
    }, url);
    expect(result).toEqual({ valid: false, reason: 'client_id does not match the document URL' });
  });

  it('rejects missing redirect_uris', () => {
    const result = validateCimdDocument({
      client_id: url,
    }, url);
    expect(result).toEqual({ valid: false, reason: 'missing or non-array redirect_uris field' });
  });

  it('rejects non-array redirect_uris', () => {
    const result = validateCimdDocument({
      client_id: url,
      redirect_uris: 'http://127.0.0.1:8080/callback',
    }, url);
    expect(result).toEqual({ valid: false, reason: 'missing or non-array redirect_uris field' });
  });

  it('rejects non-string redirect_uris entry', () => {
    const result = validateCimdDocument({
      client_id: url,
      redirect_uris: ['http://127.0.0.1:8080/callback', 123],
    }, url);
    expect(result).toEqual({ valid: false, reason: 'redirect_uris[1] is not a string' });
  });

  it('rejects forbidden token_endpoint_auth_method: client_secret_post', () => {
    const result = validateCimdDocument({
      client_id: url,
      redirect_uris: ['http://127.0.0.1:8080/callback'],
      token_endpoint_auth_method: 'client_secret_post',
    }, url);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain('client_secret_post');
    }
  });

  it('rejects forbidden token_endpoint_auth_method: client_secret_basic', () => {
    const result = validateCimdDocument({
      client_id: url,
      redirect_uris: ['http://127.0.0.1:8080/callback'],
      token_endpoint_auth_method: 'client_secret_basic',
    }, url);
    expect(result.valid).toBe(false);
  });

  it('rejects forbidden token_endpoint_auth_method: client_secret_jwt', () => {
    const result = validateCimdDocument({
      client_id: url,
      redirect_uris: ['http://127.0.0.1:8080/callback'],
      token_endpoint_auth_method: 'client_secret_jwt',
    }, url);
    expect(result.valid).toBe(false);
  });

  it('accepts token_endpoint_auth_method: none', () => {
    const result = validateCimdDocument({
      client_id: url,
      redirect_uris: ['http://127.0.0.1:8080/callback'],
      token_endpoint_auth_method: 'none',
    }, url);
    expect(result.valid).toBe(true);
  });

  it('accepts token_endpoint_auth_method: private_key_jwt', () => {
    const result = validateCimdDocument({
      client_id: url,
      redirect_uris: ['http://127.0.0.1:8080/callback'],
      token_endpoint_auth_method: 'private_key_jwt',
    }, url);
    expect(result.valid).toBe(true);
  });

  it('rejects document with client_secret', () => {
    const result = validateCimdDocument({
      client_id: url,
      redirect_uris: ['http://127.0.0.1:8080/callback'],
      client_secret: 'some-secret',
    }, url);
    expect(result).toEqual({ valid: false, reason: 'client_secret must not be present in CIMD documents' });
  });

  it('rejects document with client_secret_expires_at', () => {
    const result = validateCimdDocument({
      client_id: url,
      redirect_uris: ['http://127.0.0.1:8080/callback'],
      client_secret_expires_at: 12345,
    }, url);
    expect(result).toEqual({ valid: false, reason: 'client_secret_expires_at must not be present in CIMD documents' });
  });
});

describe('validateRedirectUri', () => {
  const doc: CimdDocument = {
    client_id: 'https://cursor.com/oauth.json',
    redirect_uris: [
      'http://127.0.0.1:8080/callback',
      'http://localhost:9999/auth',
    ],
  };

  it('returns true for exact match', () => {
    expect(validateRedirectUri('http://127.0.0.1:8080/callback', doc)).toBe(true);
  });

  it('returns true for second registered URI', () => {
    expect(validateRedirectUri('http://localhost:9999/auth', doc)).toBe(true);
  });

  it('returns false for non-matching URI', () => {
    expect(validateRedirectUri('http://evil.com/steal', doc)).toBe(false);
  });

  it('returns false for partial match (prefix)', () => {
    expect(validateRedirectUri('http://127.0.0.1:8080/callback/extra', doc)).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(validateRedirectUri('http://127.0.0.1:8080/Callback', doc)).toBe(false);
  });
});

describe('isPrivateIP', () => {
  it('detects 10.x.x.x as private', () => {
    expect(isPrivateIP('10.0.0.1')).toBe(true);
    expect(isPrivateIP('10.255.255.255')).toBe(true);
  });

  it('detects 172.16-31.x.x as private', () => {
    expect(isPrivateIP('172.16.0.1')).toBe(true);
    expect(isPrivateIP('172.31.255.255')).toBe(true);
    expect(isPrivateIP('172.15.0.1')).toBe(false);
    expect(isPrivateIP('172.32.0.1')).toBe(false);
  });

  it('detects 192.168.x.x as private', () => {
    expect(isPrivateIP('192.168.0.1')).toBe(true);
    expect(isPrivateIP('192.168.255.255')).toBe(true);
  });

  it('detects 127.x.x.x as private', () => {
    expect(isPrivateIP('127.0.0.1')).toBe(true);
    expect(isPrivateIP('127.255.255.255')).toBe(true);
  });

  it('detects 169.254.x.x as private', () => {
    expect(isPrivateIP('169.254.0.1')).toBe(true);
  });

  it('detects 0.0.0.0 as private', () => {
    expect(isPrivateIP('0.0.0.0')).toBe(true);
  });

  it('allows public IPv4', () => {
    expect(isPrivateIP('8.8.8.8')).toBe(false);
    expect(isPrivateIP('93.184.216.34')).toBe(false);
  });

  it('detects ::1 as private', () => {
    expect(isPrivateIP('::1')).toBe(true);
  });

  it('detects fc00::/fd00:: as private', () => {
    expect(isPrivateIP('fc00::1')).toBe(true);
    expect(isPrivateIP('fd12:3456::1')).toBe(true);
  });

  it('detects fe80:: as private', () => {
    expect(isPrivateIP('fe80::1')).toBe(true);
  });

  it('detects IPv6-mapped IPv4 private addresses', () => {
    expect(isPrivateIP('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateIP('::ffff:192.168.1.1')).toBe(true);
    expect(isPrivateIP('::ffff:127.0.0.1')).toBe(true);
  });

  it('allows IPv6-mapped IPv4 public addresses', () => {
    expect(isPrivateIP('::ffff:8.8.8.8')).toBe(false);
  });
});

describe('CimdCache', () => {
  const pinnedUrls = new Set(['https://cursor.com/oauth.json']);
  const mockDoc: CimdDocument = {
    client_id: 'https://cursor.com/oauth.json',
    redirect_uris: ['http://127.0.0.1:8080/callback'],
  };

  it('returns cached doc within TTL', async () => {
    const cache = new CimdCache({ ttlMinutes: 30, pinnedUrls });
    const fetcher = jest.fn().mockResolvedValue(mockDoc);

    const first = await cache.get('https://cursor.com/oauth.json', fetcher);
    const second = await cache.get('https://cursor.com/oauth.json', fetcher);

    expect(first).toEqual(mockDoc);
    expect(second).toEqual(mockDoc);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('re-fetches after TTL expires', async () => {
    const cache = new CimdCache({ ttlMinutes: 0, pinnedUrls: new Set() });
    const fetcher = jest.fn().mockResolvedValue(mockDoc);

    await cache.get('https://cursor.com/oauth.json', fetcher);
    await cache.get('https://cursor.com/oauth.json', fetcher);

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not cache errors', async () => {
    const cache = new CimdCache({ ttlMinutes: 30, pinnedUrls: new Set() });
    const fetcher = jest.fn()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce(mockDoc);

    await expect(cache.get('https://cursor.com/oauth.json', fetcher)).rejects.toThrow('fetch failed');
    const result = await cache.get('https://cursor.com/oauth.json', fetcher);
    expect(result).toEqual(mockDoc);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('evicts oldest unpinned entry when max size reached', async () => {
    const cache = new CimdCache({ ttlMinutes: 30, pinnedUrls, maxUnpinnedSize: 2 });
    const makeFetcher = (url: string) => jest.fn().mockResolvedValue({
      ...mockDoc,
      client_id: url,
    });

    await cache.get('https://cursor.com/oauth.json', makeFetcher('https://cursor.com/oauth.json'));
    await cache.get('https://a.com/oauth.json', makeFetcher('https://a.com/oauth.json'));
    await cache.get('https://b.com/oauth.json', makeFetcher('https://b.com/oauth.json'));
    await cache.get('https://c.com/oauth.json', makeFetcher('https://c.com/oauth.json'));

    // Pinned (cursor) + 2 unpinned = 3 total (oldest unpinned evicted)
    expect(cache.size).toBe(3);
  });

  it('never evicts pinned entries', async () => {
    const cache = new CimdCache({ ttlMinutes: 30, pinnedUrls, maxUnpinnedSize: 1 });
    const fetcher = jest.fn().mockResolvedValue(mockDoc);

    await cache.get('https://cursor.com/oauth.json', fetcher);
    await cache.get('https://a.com/o.json', jest.fn().mockResolvedValue({ ...mockDoc, client_id: 'https://a.com/o.json' }));
    await cache.get('https://b.com/o.json', jest.fn().mockResolvedValue({ ...mockDoc, client_id: 'https://b.com/o.json' }));

    // Pinned cursor stays, only 1 unpinned slot
    expect(cache.size).toBe(2);
    // Verify pinned is still there
    const result = await cache.get('https://cursor.com/oauth.json', fetcher);
    expect(result).toEqual(mockDoc);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('clear() removes all entries', async () => {
    const cache = new CimdCache({ ttlMinutes: 30, pinnedUrls });
    await cache.get('https://cursor.com/oauth.json', jest.fn().mockResolvedValue(mockDoc));
    expect(cache.size).toBe(1);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

describe('sanitizeForError', () => {
  it('passes through short clean strings', () => {
    expect(sanitizeForError('hello world')).toBe('hello world');
  });

  it('truncates long strings', () => {
    const long = 'a'.repeat(300);
    const result = sanitizeForError(long);
    expect(result.length).toBe(259); // 256 + '...'
    expect(result.endsWith('...')).toBe(true);
  });

  it('strips control characters', () => {
    expect(sanitizeForError('hello\x00\x0a\x1fworld')).toBe('helloworld');
  });

  it('handles custom max length', () => {
    const result = sanitizeForError('abcdefgh', 5);
    expect(result).toBe('abcde...');
  });
});
