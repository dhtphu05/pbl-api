/**
 * Settings of integration read from the environment (the one place it is
 * read). Required values fail closed: the service does not start without them,
 * except under NODE_ENV=test, where the tests set their own.
 */
export const INTERNAL_TOKEN_HEADER = 'x-internal-token';

const isTest = (env: Record<string, string | undefined>) =>
  env.NODE_ENV === 'test';

/** The background sync job worker; off under NODE_ENV=test, where tests run jobs themselves. */
export function isSyncJobWorkerEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.INTEGRATION_SYNC_WORKER_ENABLED !== undefined) {
    return env.INTEGRATION_SYNC_WORKER_ENABLED === 'true';
  }
  return !isTest(env);
}

export function readCredentialMasterKey(
  env: Record<string, string | undefined> = process.env,
): string {
  const key = env.INTEGRATION_CREDENTIAL_MASTER_KEY;
  if (!key) {
    throw new Error(
      'INTEGRATION_CREDENTIAL_MASTER_KEY is not set: marketplace credentials cannot be encrypted',
    );
  }
  return key;
}

export function readSalesUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  const url = env.SALES_SERVICE_URL;
  if (!url) {
    throw new Error(
      'SALES_SERVICE_URL is not set: integration cannot create sales orders',
    );
  }
  return url.replace(/\/+$/, '');
}

/** The shared secret sent to sales in `x-internal-token` (rule 6). */
export function readInternalToken(
  env: Record<string, string | undefined> = process.env,
): string {
  const token = env.INTERNAL_S2S_TOKEN;
  if (!token) {
    throw new Error(
      'INTERNAL_S2S_TOKEN is not set: integration cannot call other services',
    );
  }
  return token;
}

/** Read-only Lazada integration is explicitly enabled only when credentials are present. */
export function assertLazadaConfig(env: Record<string, string | undefined> = process.env): void {
  if (env.LAZADA_LIVE_ENABLED !== 'true') return;
  for (const name of ['LAZADA_APP_KEY', 'LAZADA_APP_SECRET', 'LAZADA_OAUTH_STATE_SECRET', 'LAZADA_CALLBACK_URL']) {
    if (!env[name]) throw new Error(name + ' is required when LAZADA_LIVE_ENABLED=true');
  }
  if (Buffer.byteLength(env.LAZADA_OAUTH_STATE_SECRET!, 'utf8') < 32) {
    throw new Error('LAZADA_OAUTH_STATE_SECRET must contain at least 32 bytes');
  }
  const url = new URL(env.LAZADA_CALLBACK_URL!);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('LAZADA_CALLBACK_URL must be a plain HTTPS callback URL');
  }
  if (env.LAZADA_POST_AUTH_REDIRECT_URL) {
    const successUrl = new URL(env.LAZADA_POST_AUTH_REDIRECT_URL);
    if (successUrl.protocol !== 'https:' || successUrl.username || successUrl.password) {
      throw new Error('LAZADA_POST_AUTH_REDIRECT_URL must be HTTPS');
    }
  }
}

/** Called before the app starts: throws (naming the variable, never a value) when a required one is missing. */
export function assertIntegrationConfig(
  env: Record<string, string | undefined> = process.env,
): void {
  if (isTest(env)) return;
  readCredentialMasterKey(env);
  readSalesUrl(env);
  readInternalToken(env);
  assertLazadaConfig(env);
}
