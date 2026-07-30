import { vi } from 'vitest';
import { createLogger, truncateClientIdForLog, truncateUriForLog } from '../src/logger';

function captureLog(method: 'log' | 'warn' | 'error', fn: () => void): string {
  const spy = vi.spyOn(console, method).mockImplementation(() => {});
  try {
    fn();
    expect(spy).toHaveBeenCalledOnce();
    return spy.mock.calls[0][0] as string;
  } finally {
    spy.mockRestore();
  }
}

describe('logger formatting', () => {
  const logger = createLogger(true);

  describe('value quoting', () => {
    it('always wraps values in double quotes', () => {
      const line = captureLog('log', () => logger.info('hello'));
      expect(line).toContain('msg="hello"');
      expect(line).toContain('level="info"');
    });

    it('quotes values without spaces', () => {
      const line = captureLog('log', () => logger.info('test', { method: 'GET' }));
      expect(line).toContain('method="GET"');
    });

    it('quotes values with spaces', () => {
      const line = captureLog('log', () => logger.info('well-known request'));
      expect(line).toContain('msg="well-known request"');
    });

    it('replaces double quotes inside values with single quotes', () => {
      const line = captureLog('log', () => logger.info('said "hello"'));
      expect(line).toContain("msg=\"said 'hello'\"");
      expect(line).not.toContain('\\"');
    });

    it('handles values with only double quotes', () => {
      const line = captureLog('log', () => logger.info('test', { val: '""' }));
      expect(line).toContain("val=\"''\"");
    });

    it('quotes empty string values', () => {
      const line = captureLog('log', () => logger.info('test', { val: '' }));
      expect(line).toContain('val=""');
    });

    it('quotes numeric values', () => {
      const line = captureLog('log', () => logger.info('test', { status: 200 }));
      expect(line).toContain('status="200"');
    });

    it('handles values with equals sign', () => {
      const line = captureLog('log', () => logger.info('test', { query: 'a=1' }));
      expect(line).toContain('query="a=1"');
    });

    it('handles values with backslash', () => {
      const line = captureLog('log', () => logger.info('test', { path: 'C:\\Users' }));
      expect(line).toContain('path="C:\\Users"');
    });
  });

  describe('line structure', () => {
    it('produces ts= level= msg= format', () => {
      const line = captureLog('log', () => logger.info('test'));
      expect(line).toMatch(/^ts="[^"]+" level="info" msg="test"$/);
    });

    it('appends meta fields after msg', () => {
      const line = captureLog('log', () => logger.info('req', { method: 'GET', path: '/foo' }));
      expect(line).toMatch(/msg="req" method="GET" path="\/foo"$/);
    });

    it('skips null and undefined meta values', () => {
      const line = captureLog('log', () => logger.info('test', { a: null, b: undefined, c: 'ok' }));
      expect(line).not.toContain('a=');
      expect(line).not.toContain('b=');
      expect(line).toContain('c="ok"');
    });
  });

  describe('log levels', () => {
    it('info writes to console.log', () => {
      const line = captureLog('log', () => logger.info('msg'));
      expect(line).toContain('level="info"');
    });

    it('warn writes to console.warn', () => {
      const line = captureLog('warn', () => logger.warn('msg'));
      expect(line).toContain('level="warn"');
    });

    it('error writes to console.error', () => {
      const line = captureLog('error', () => logger.error('msg'));
      expect(line).toContain('level="error"');
    });

    it('debug writes to console.log when enabled', () => {
      const line = captureLog('log', () => logger.debug('msg'));
      expect(line).toContain('level="debug"');
    });

    it('debug is suppressed when disabled', () => {
      const quietLogger = createLogger(false);
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        quietLogger.debug('msg');
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe('truncateClientIdForLog', () => {
  it('leaves opaque client_ids unchanged', () => {
    expect(truncateClientIdForLog('my-client')).toBe('my-client');
  });

  it('truncates https CIMD client_ids to 80 chars', () => {
    const long = `https://example.com/${'a'.repeat(100)}`;
    expect(truncateClientIdForLog(long)).toBe(long.slice(0, 80));
    expect(truncateClientIdForLog(long).length).toBe(80);
  });

  it('does not truncate short https client_ids', () => {
    expect(truncateClientIdForLog('https://example.com/client')).toBe('https://example.com/client');
  });
});

describe('truncateUriForLog', () => {
  it('leaves short URIs unchanged', () => {
    expect(truncateUriForLog('https://app.example.com/callback')).toBe('https://app.example.com/callback');
  });

  it('truncates URIs longer than 200 chars', () => {
    const long = `https://example.com/${'a'.repeat(250)}`;
    expect(truncateUriForLog(long)).toBe(long.slice(0, 200));
    expect(truncateUriForLog(long).length).toBe(200);
  });
});
