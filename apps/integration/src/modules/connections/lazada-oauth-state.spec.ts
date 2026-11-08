import {
  createLazadaOAuthState,
  verifyLazadaOAuthState,
} from './lazada-oauth-state';

describe('Lazada OAuth signed state', () => {
  const oldSecret = process.env.LAZADA_OAUTH_STATE_SECRET;
  beforeEach(() => {
    process.env.LAZADA_OAUTH_STATE_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef';
  });
  afterAll(() => {
    if (oldSecret === undefined) delete process.env.LAZADA_OAUTH_STATE_SECRET;
    else process.env.LAZADA_OAUTH_STATE_SECRET = oldSecret;
  });
  const claims = {
    tenantId: '123e4567-e89b-42d3-a456-426614174000',
    connectionId: '123e4567-e89b-42d3-a456-426614174001',
    actorId: 'test-user',
  };

  it('round trips a signed tenant and connection identity', () => {
    const state = createLazadaOAuthState(claims, 1_000_000);
    expect(verifyLazadaOAuthState(state, 1_100_000)).toEqual(
      expect.objectContaining(claims),
    );
  });

  it('rejects tampering and expiration', () => {
    const state = createLazadaOAuthState(claims, 1_000_000);
    expect(() => verifyLazadaOAuthState(state + 'x', 1_100_000)).toThrow();
    expect(() => verifyLazadaOAuthState(state, 1_700_001)).toThrow();
  });
});
