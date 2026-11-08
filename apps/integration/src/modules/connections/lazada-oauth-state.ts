import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface LazadaOAuthStateClaims {
  tenantId: string;
  connectionId: string;
  actorId: string;
  issuedAt: number;
  nonce: string;
}

const TEN_MINUTES_MS = 10 * 60 * 1000;

function stateSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.LAZADA_OAUTH_STATE_SECRET;
  if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('LAZADA_OAUTH_STATE_SECRET must contain at least 32 bytes');
  }
  return secret;
}

function signature(payload: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(payload, 'utf8').digest();
}

export function createLazadaOAuthState(
  claims: Pick<LazadaOAuthStateClaims, 'tenantId' | 'connectionId' | 'actorId'>,
  now = Date.now(),
): string {
  const payload = Buffer.from(
    JSON.stringify({ ...claims, issuedAt: now, nonce: randomBytes(24).toString('hex') }),
    'utf8',
  ).toString('base64url');
  return payload + '.' + signature(payload, stateSecret()).toString('base64url');
}

export function validateSignedOAuthState(
  state: string,
  now = Date.now(),
): LazadaOAuthStateClaims {
  if (!state || state.length > 1500) {
    throw new Error('Invalid OAuth state');
  }
  const pieces = state.split('.');
  if (pieces.length !== 2 || !pieces[0] || !pieces[1]) {
    throw new Error('Invalid OAuth state');
  }
  const actual = Buffer.from(pieces[1], 'base64url');
  const expected = signature(pieces[0], stateSecret());
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error('Invalid OAuth state signature');
  }
  let value: Partial<LazadaOAuthStateClaims>;
  try {
    value = JSON.parse(Buffer.from(pieces[0], 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid OAuth state payload');
  }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    !value ||
    typeof value.tenantId !== 'string' || !uuid.test(value.tenantId) ||
    typeof value.connectionId !== 'string' || !uuid.test(value.connectionId) ||
    typeof value.actorId !== 'string' || value.actorId.length < 1 ||
    typeof value.nonce !== 'string' || value.nonce.length !== 48 ||
    typeof value.issuedAt !== 'number' ||
    value.issuedAt > now + 60_000 ||
    now - value.issuedAt > TEN_MINUTES_MS
  ) {
    throw new Error('Expired or malformed OAuth state');
  }
  return value as LazadaOAuthStateClaims;
}
