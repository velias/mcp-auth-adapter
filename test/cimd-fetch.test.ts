import { fetchCimdDocument, validateHostNotPrivate } from '../src/cimd';
import * as dns from 'dns';

jest.mock('dns', () => ({
  promises: {
    lookup: jest.fn(),
  },
}));

const mockDnsLookup = dns.promises.lookup as jest.MockedFunction<typeof dns.promises.lookup>;

const VALID_CIMD_URL = 'https://cursor.com/oauth-client.json';
const VALID_CIMD_DOC = JSON.stringify({
  client_id: VALID_CIMD_URL,
  redirect_uris: ['http://127.0.0.1:8080/callback'],
  client_name: 'Cursor',
});

function mockFetchResponse(options: {
  status?: number;
  body?: string;
  contentType?: string;
  headers?: Record<string, string>;
} = {}) {
  const {
    status = 200,
    body = VALID_CIMD_DOC,
    contentType = 'application/json',
    headers = {},
  } = options;

  const allHeaders: Record<string, string> = { 'content-type': contentType, ...headers };
  const encoder = new TextEncoder();
  const encoded = encoder.encode(body);

  const mockResponse = {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => allHeaders[name.toLowerCase()] ?? null,
    },
    body: {
      getReader: () => {
        let consumed = false;
        return {
          read: () => {
            if (consumed) return Promise.resolve({ done: true, value: undefined });
            consumed = true;
            return Promise.resolve({ done: false, value: encoded });
          },
          cancel: () => Promise.resolve(),
          releaseLock: () => {},
        };
      },
    },
  };

  (globalThis.fetch as jest.Mock) = jest.fn().mockResolvedValue(mockResponse);
}

function mockDnsPublic() {
  mockDnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
}

beforeEach(() => {
  jest.restoreAllMocks();
  mockDnsPublic();
});

describe('fetchCimdDocument', () => {
  it('fetches and validates a valid CIMD document', async () => {
    mockFetchResponse();
    const doc = await fetchCimdDocument(VALID_CIMD_URL);
    expect(doc.client_id).toBe(VALID_CIMD_URL);
    expect(doc.redirect_uris).toEqual(['http://127.0.0.1:8080/callback']);
    expect(doc.client_name).toBe('Cursor');
  });

  it('passes redirect: error to fetch', async () => {
    mockFetchResponse();
    await fetchCimdDocument(VALID_CIMD_URL);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      VALID_CIMD_URL,
      expect.objectContaining({ redirect: 'error' }),
    );
  });

  it('rejects redirect responses (3xx)', async () => {
    (globalThis.fetch as jest.Mock) = jest.fn().mockRejectedValue(
      new TypeError('fetch failed: redirect mode is set to error'),
    );
    await expect(fetchCimdDocument(VALID_CIMD_URL)).rejects.toThrow();
  });

  it('rejects non-200 responses', async () => {
    mockFetchResponse({ status: 404 });
    await expect(fetchCimdDocument(VALID_CIMD_URL)).rejects.toThrow('HTTP 404');
  });

  it('rejects invalid Content-Type', async () => {
    mockFetchResponse({ contentType: 'text/html' });
    await expect(fetchCimdDocument(VALID_CIMD_URL)).rejects.toThrow('invalid Content-Type');
  });

  it('accepts application/json content type', async () => {
    mockFetchResponse({ contentType: 'application/json; charset=utf-8' });
    const doc = await fetchCimdDocument(VALID_CIMD_URL);
    expect(doc.client_id).toBe(VALID_CIMD_URL);
  });

  it('accepts application/*+json content type', async () => {
    mockFetchResponse({ contentType: 'application/vnd.example+json' });
    const doc = await fetchCimdDocument(VALID_CIMD_URL);
    expect(doc.client_id).toBe(VALID_CIMD_URL);
  });

  it('rejects response exceeding 5KB', async () => {
    const largeBody = 'x'.repeat(6000);
    mockFetchResponse({ body: largeBody });
    await expect(fetchCimdDocument(VALID_CIMD_URL)).rejects.toThrow('exceeds maximum size');
  });

  it('rejects malformed JSON', async () => {
    mockFetchResponse({ body: 'not json {{{' });
    await expect(fetchCimdDocument(VALID_CIMD_URL)).rejects.toThrow('not valid JSON');
  });

  it('rejects client_id mismatch in document', async () => {
    mockFetchResponse({
      body: JSON.stringify({
        client_id: 'https://different.com/oauth.json',
        redirect_uris: ['http://127.0.0.1:8080/callback'],
      }),
    });
    await expect(fetchCimdDocument(VALID_CIMD_URL)).rejects.toThrow('client_id does not match');
  });
});

describe('SSRF protection via validateHostNotPrivate', () => {
  it('rejects private IPv4: 10.x.x.x', async () => {
    mockDnsLookup.mockResolvedValue([{ address: '10.0.0.1', family: 4 }] as never);
    await expect(validateHostNotPrivate('evil.com')).rejects.toThrow('private/reserved IP');
  });

  it('rejects private IPv4: 172.16.x.x', async () => {
    mockDnsLookup.mockResolvedValue([{ address: '172.16.0.1', family: 4 }] as never);
    await expect(validateHostNotPrivate('evil.com')).rejects.toThrow('private/reserved IP');
  });

  it('rejects private IPv4: 192.168.x.x', async () => {
    mockDnsLookup.mockResolvedValue([{ address: '192.168.1.1', family: 4 }] as never);
    await expect(validateHostNotPrivate('evil.com')).rejects.toThrow('private/reserved IP');
  });

  it('rejects loopback: 127.0.0.1', async () => {
    mockDnsLookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as never);
    await expect(validateHostNotPrivate('evil.com')).rejects.toThrow('private/reserved IP');
  });

  it('rejects link-local: 169.254.x.x', async () => {
    mockDnsLookup.mockResolvedValue([{ address: '169.254.1.1', family: 4 }] as never);
    await expect(validateHostNotPrivate('evil.com')).rejects.toThrow('private/reserved IP');
  });

  it('rejects IPv6 loopback: ::1', async () => {
    mockDnsLookup.mockResolvedValue([{ address: '::1', family: 6 }] as never);
    await expect(validateHostNotPrivate('evil.com')).rejects.toThrow('private/reserved IP');
  });

  it('rejects IPv6 unique local: fc00::', async () => {
    mockDnsLookup.mockResolvedValue([{ address: 'fc00::1', family: 6 }] as never);
    await expect(validateHostNotPrivate('evil.com')).rejects.toThrow('private/reserved IP');
  });

  it('rejects IPv6 link-local: fe80::', async () => {
    mockDnsLookup.mockResolvedValue([{ address: 'fe80::1', family: 6 }] as never);
    await expect(validateHostNotPrivate('evil.com')).rejects.toThrow('private/reserved IP');
  });

  it('rejects IPv6-mapped IPv4: ::ffff:10.0.0.1', async () => {
    mockDnsLookup.mockResolvedValue([{ address: '::ffff:10.0.0.1', family: 6 }] as never);
    await expect(validateHostNotPrivate('evil.com')).rejects.toThrow('private/reserved IP');
  });

  it('allows public IPv4', async () => {
    mockDnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
    await expect(validateHostNotPrivate('example.com')).resolves.toBeUndefined();
  });

  it('rejects if any resolved address is private', async () => {
    mockDnsLookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ] as never);
    await expect(validateHostNotPrivate('dual.com')).rejects.toThrow('private/reserved IP');
  });
});
