import * as crypto from 'crypto';

export interface StatePayload {
  redirectUri: string;
  state: string | null;
}

interface InternalPayload {
  r: string;
  s: string | null;
  exp: number;
}

const HMAC_ALGO = 'sha256';
const SEPARATOR = '.';

function base64urlEncode(buf: Buffer): string {
  return buf.toString('base64url');
}

function base64urlDecode(str: string): Buffer {
  return Buffer.from(str, 'base64url');
}

/**
 * Signs a state payload with HMAC-SHA256. Returns a compact base64url blob:
 * `<base64url(JSON payload)>.<base64url(HMAC signature)>`
 *
 * Always signs with the provided secret (primary key).
 */
export function signState(payload: StatePayload, secret: Buffer, ttlSeconds: number): string {
  const internal: InternalPayload = {
    r: payload.redirectUri,
    s: payload.state,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };

  const payloadBuf = Buffer.from(JSON.stringify(internal), 'utf8');
  const payloadB64 = base64urlEncode(payloadBuf);

  const mac = crypto.createHmac(HMAC_ALGO, secret)
    .update(payloadB64, 'utf8')
    .digest();

  return `${payloadB64}${SEPARATOR}${base64urlEncode(mac)}`;
}

/**
 * Verifies a signed state blob and returns the original payload.
 * Supports key rotation: tries each secret in order (primary first, then previous).
 * Returns null if verification fails (tampered, expired, or malformed).
 *
 * Security: verifies signature BEFORE parsing JSON payload.
 */
export function verifyState(blob: string, secrets: Buffer[]): StatePayload | null {
  const sepIdx = blob.lastIndexOf(SEPARATOR);
  if (sepIdx <= 0) return null;

  const payloadB64 = blob.slice(0, sepIdx);
  const sigB64 = blob.slice(sepIdx + 1);

  let sigBuf: Buffer;
  try {
    sigBuf = base64urlDecode(sigB64);
  } catch {
    return null;
  }

  if (sigBuf.length === 0) return null;

  let verified = false;
  for (const secret of secrets) {
    const expectedMac = crypto.createHmac(HMAC_ALGO, secret)
      .update(payloadB64, 'utf8')
      .digest();

    if (expectedMac.length === sigBuf.length && crypto.timingSafeEqual(expectedMac, sigBuf)) {
      verified = true;
      break;
    }
  }

  if (!verified) return null;

  let payloadBuf: Buffer;
  try {
    payloadBuf = base64urlDecode(payloadB64);
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadBuf.toString('utf8'));
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const obj = parsed as Record<string, unknown>;
  const r = obj.r;
  const s = obj.s;
  const exp = obj.exp;

  if (typeof r !== 'string') return null;
  if (s !== null && typeof s !== 'string') return null;
  if (typeof exp !== 'number') return null;

  const now = Math.floor(Date.now() / 1000);
  if (now > exp) return null;

  return { redirectUri: r, state: typeof s === 'string' ? s : null };
}
