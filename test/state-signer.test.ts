import { signState, verifyState } from '../src/state-signer';

const SECRET_A = Buffer.from('a'.repeat(64), 'hex');
const SECRET_B = Buffer.from('b'.repeat(64), 'hex');
const SECRET_C = Buffer.from('c'.repeat(64), 'hex');

describe('signState / verifyState', () => {
  it('roundtrips a payload with state', () => {
    const blob = signState({ redirectUri: 'http://localhost:8080/cb', state: 'xyz' }, SECRET_A, 300);
    const result = verifyState(blob, [SECRET_A]);
    expect(result).toEqual({ redirectUri: 'http://localhost:8080/cb', state: 'xyz' });
  });

  it('roundtrips a payload with null state', () => {
    const blob = signState({ redirectUri: 'http://localhost/cb', state: null }, SECRET_A, 300);
    const result = verifyState(blob, [SECRET_A]);
    expect(result).toEqual({ redirectUri: 'http://localhost/cb', state: null });
  });

  it('roundtrips a payload with empty string state', () => {
    const blob = signState({ redirectUri: 'http://localhost/cb', state: '' }, SECRET_A, 300);
    const result = verifyState(blob, [SECRET_A]);
    expect(result).toEqual({ redirectUri: 'http://localhost/cb', state: '' });
  });

  it('roundtrips with long redirect URI', () => {
    const longUri = 'http://localhost:8080/' + 'a'.repeat(2000);
    const blob = signState({ redirectUri: longUri, state: 'x' }, SECRET_A, 300);
    const result = verifyState(blob, [SECRET_A]);
    expect(result?.redirectUri).toBe(longUri);
  });

  it('roundtrips with unicode in state', () => {
    const blob = signState({ redirectUri: 'http://localhost/cb', state: '日本語テスト' }, SECRET_A, 300);
    const result = verifyState(blob, [SECRET_A]);
    expect(result?.state).toBe('日本語テスト');
  });

  it('returns null for tampered signature', () => {
    const blob = signState({ redirectUri: 'http://localhost/cb', state: 's' }, SECRET_A, 300);
    const parts = blob.split('.');
    const tampered = parts[0] + '.AAAA' + parts[1].slice(4);
    expect(verifyState(tampered, [SECRET_A])).toBeNull();
  });

  it('returns null for tampered payload', () => {
    const blob = signState({ redirectUri: 'http://localhost/cb', state: 's' }, SECRET_A, 300);
    const parts = blob.split('.');
    const tamperedPayload = Buffer.from('{"r":"http://evil.com","s":"s","exp":9999999999}').toString('base64url');
    const tampered = tamperedPayload + '.' + parts[1];
    expect(verifyState(tampered, [SECRET_A])).toBeNull();
  });

  it('returns null for expired blob', () => {
    const blob = signState({ redirectUri: 'http://localhost/cb', state: 's' }, SECRET_A, -1);
    expect(verifyState(blob, [SECRET_A])).toBeNull();
  });

  it('returns null for wrong key', () => {
    const blob = signState({ redirectUri: 'http://localhost/cb', state: 's' }, SECRET_A, 300);
    expect(verifyState(blob, [SECRET_B])).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(verifyState('', [SECRET_A])).toBeNull();
  });

  it('returns null for blob without separator', () => {
    expect(verifyState('noseparatorhere', [SECRET_A])).toBeNull();
  });

  it('returns null for malformed base64', () => {
    expect(verifyState('!!!.!!!', [SECRET_A])).toBeNull();
  });
});

describe('key rotation', () => {
  it('verifies blob signed with previous key when provided', () => {
    const blob = signState({ redirectUri: 'http://localhost/cb', state: 'old' }, SECRET_A, 300);
    const result = verifyState(blob, [SECRET_B, SECRET_A]);
    expect(result).toEqual({ redirectUri: 'http://localhost/cb', state: 'old' });
  });

  it('prefers primary key (tries it first)', () => {
    const blob = signState({ redirectUri: 'http://localhost/cb', state: 'x' }, SECRET_A, 300);
    const result = verifyState(blob, [SECRET_A, SECRET_B]);
    expect(result).toEqual({ redirectUri: 'http://localhost/cb', state: 'x' });
  });

  it('fails when blob signed with unknown key even with previous set', () => {
    const blob = signState({ redirectUri: 'http://localhost/cb', state: 'x' }, SECRET_C, 300);
    expect(verifyState(blob, [SECRET_A, SECRET_B])).toBeNull();
  });

  it('fails when previous key is not provided', () => {
    const blob = signState({ redirectUri: 'http://localhost/cb', state: 'x' }, SECRET_A, 300);
    expect(verifyState(blob, [SECRET_B])).toBeNull();
  });
});
