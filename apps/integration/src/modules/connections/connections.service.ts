import { Injectable } from '@nestjs/common';
import { TenantContext } from '@pbl/common';
import {
  INTEGRATION_CONNECTION_CONNECTED,
  INTEGRATION_CONNECTION_DISCONNECTED,
  INTEGRATION_CONNECTION_REAUTH_REQUIRED,
  IntegrationConnectionEventPayload,
} from '@pbl/contracts';
import { EventOutbox } from '@pbl/events';
import { randomBytes, randomUUID } from 'node:crypto';
import { DataSource, QueryFailedError } from 'typeorm';
import {
  ConnectionStatus,
  IntegrationDomainError,
  IntegrationDomainErrorCode,
  MarketplaceProvider,
  assertValidConnectionTransition,
  decryptCredentialSecret,
  encryptCredentialSecret,
} from '../../domain/integration-domain';
import { nextIntegrationCode } from '../../infrastructure/persistence/integration-code.generator';
import {
  ChannelConnectionEntity,
  ConnectionCredentialEntity,
  IntegrationAuditLogEntity,
} from '../../infrastructure/persistence/integration.entities';
import { ProviderRateLimiterService } from '../../infrastructure/rate-limiting/provider-rate-limiter.service';
import { createLazadaOAuthState } from './lazada-oauth-state';
import { ProviderRegistryService } from '../../providers/provider-registry.service';
import {
  AuthorizeChannelConnectionDto,
  CreateChannelConnectionDto,
  RefreshConnectionTokenDto,
} from './connections.dto';

export interface SanitizedChannelConnectionView {
  id: string;
  tenantId: string;
  code: string;
  provider: MarketplaceProvider;
  connectionKey: string;
  externalShopId: string;
  shopName: string;
  branchId: string;
  warehouseId: string | null;
  status: ConnectionStatus;
  safetyStockBuffer: number;
  stockAllocationPercent: number;
  lastSyncAt: string | null;
  lastOrderSyncAt: string | null;
  lastInventorySyncAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  consecutiveFailures: number;
  credentialSummary: {
    credentialVersion: number;
    hasAccessToken: boolean;
    hasRefreshToken: boolean;
    accessTokenExpiresAt: string | null;
    refreshTokenExpiresAt: string | null;
    lastRefreshedAt: string | null;
  };
  createdAt: string;
  updatedAt: string;
}

export interface DecryptedConnectionCredentials {
  connection: ChannelConnectionEntity;
  credentialVersion: number;
  accessToken: string;
  refreshToken: string | null;
  webhookSecret: string;
  partnerId: string | null;
}

@Injectable()
export class ConnectionsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly providerRegistry: ProviderRegistryService,
    private readonly rateLimiter: ProviderRateLimiterService,
    private readonly outbox: EventOutbox,
  ) {}

  async createConnection(
    actorId: string,
    dto: CreateChannelConnectionDto,
  ): Promise<SanitizedChannelConnectionView> {
    const tenantId = TenantContext.require();
    const realLazada = dto.provider === 'LAZADA' && process.env.NODE_ENV !== 'test';
    if (realLazada && process.env.LAZADA_LIVE_ENABLED !== 'true') {
      throw new IntegrationDomainError(
        IntegrationDomainErrorCode.CHANNEL_AUTHORIZATION_FAILED,
        'Lazada integration is disabled or not configured',
        503,
      );
    }
    const configuredSecret = realLazada ? process.env.LAZADA_APP_SECRET : dto.webhookSecret;
    const configuredAppKey = realLazada ? process.env.LAZADA_APP_KEY : dto.partnerId;
    if (!configuredSecret || (realLazada && !configuredAppKey)) {
      throw new IntegrationDomainError(
        IntegrationDomainErrorCode.CHANNEL_AUTHORIZATION_FAILED,
        'Provider credentials are not configured on the server',
        503,
      );
    }
    const suppliedAccessToken = realLazada ? undefined : dto.accessToken;
    const suppliedRefreshToken = realLazada ? undefined : dto.refreshToken;
    const initialStatus: ConnectionStatus = suppliedAccessToken
      ? 'CONNECTED'
      : 'PENDING_AUTH';

    try {
      return await this.dataSource.transaction(async (em) => {
        await em.query(`SELECT set_config('app.tenant_id', $1, true)`, [
          tenantId,
        ]);

        const code = await nextIntegrationCode(em, tenantId, 'CON');
        const connectionKey = `ck_${dto.provider.toLowerCase()}_${randomBytes(12).toString('hex')}`;
        const now = new Date();

        const conn = em.create(ChannelConnectionEntity, {
          id: randomUUID(),
          tenantId,
          code,
          provider: dto.provider,
          connectionKey,
          externalShopId: dto.externalShopId?.trim() || ('pending-' + randomUUID()),
          shopName: dto.shopName?.trim() || (dto.provider + ' authorization pending'),
          branchId: dto.branchId,
          warehouseId: dto.warehouseId ?? null,
          status: initialStatus,
          safetyStockBuffer: dto.safetyStockBuffer ?? 0,
          stockAllocationPercent: dto.stockAllocationPercent ?? 100,
          oauthStateNonce: null,
          oauthRedirectUri: null,
          oauthInitiatedBy: null,
          lastSyncAt: initialStatus === 'CONNECTED' ? now : null,
          lastOrderSyncAt: null,
          lastInventorySyncAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          consecutiveFailures: 0,
          version: 1,
          createdBy: actorId,
        });
        await em.save(ChannelConnectionEntity, conn);

        const cred = em.create(ConnectionCredentialEntity, {
          id: randomUUID(),
          tenantId,
          connectionId: conn.id,
          credentialVersion: 1,
          encryptedAccessToken: suppliedAccessToken
            ? encryptCredentialSecret(suppliedAccessToken)
            : null,
          encryptedRefreshToken: suppliedRefreshToken
            ? encryptCredentialSecret(suppliedRefreshToken)
            : null,
          encryptedWebhookSecret: encryptCredentialSecret(configuredSecret),
          partnerId: configuredAppKey ?? (dto.provider.toLowerCase() + '-partner'),
          keyVersion: 1,
          accessTokenExpiresAt: suppliedAccessToken
            ? new Date(now.getTime() + 4 * 3600 * 1000)
            : null,
          refreshTokenExpiresAt: suppliedRefreshToken
            ? new Date(now.getTime() + 30 * 24 * 3600 * 1000)
            : null,
          scopes: 'order.read,product.stock.write,product.read',
          refreshLeaseOwner: null,
          refreshLeaseExpiresAt: null,
          lastRefreshedAt: suppliedAccessToken ? now : null,
        });
        await em.save(ConnectionCredentialEntity, cred);

        await em.save(
          IntegrationAuditLogEntity,
          em.create(IntegrationAuditLogEntity, {
            tenantId,
            connectionId: conn.id,
            actorId,
            action: 'CONNECTION_CREATED',
            targetType: 'CHANNEL_CONNECTION',
            targetId: conn.id,
            metadata: {
              provider: conn.provider,
              externalShopId: conn.externalShopId,
              status: conn.status,
            },
          }),
        );

        if (initialStatus === 'CONNECTED') {
          await this.outbox.enqueue(em, INTEGRATION_CONNECTION_CONNECTED, {
            tenantId,
            aggregateId: conn.id,
            actor: { id: actorId, type: 'account' },
            payload: {
              connectionId: conn.id,
              provider: conn.provider,
              externalShopId: conn.externalShopId,
              shopName: conn.shopName,
              branchId: conn.branchId,
              warehouseId: conn.warehouseId,
              status: conn.status,
              occurredAt: now.toISOString(),
            } satisfies IntegrationConnectionEventPayload,
          });
        }

        return this.toSanitizedView(conn, cred);
      });
    } catch (err) {
      if (
        err instanceof QueryFailedError &&
        String((err as any).code) === '23505'
      ) {
        throw new IntegrationDomainError(
          IntegrationDomainErrorCode.CHANNEL_CONNECTION_CONFLICT,
          `Shop ${dto.externalShopId} on ${dto.provider} is already connected`,
          409,
        );
      }
      throw err;
    }
  }

  async listConnections(): Promise<SanitizedChannelConnectionView[]> {
    const tenantId = TenantContext.require();
    return this.dataSource.transaction(async (em) => {
      await em.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        tenantId,
      ]);
      const conns = await em.getRepository(ChannelConnectionEntity).find({
        where: { tenantId },
        order: { createdAt: 'DESC' },
      });
      const creds = await em.getRepository(ConnectionCredentialEntity).find({
        where: { tenantId },
      });
      const credByConn = new Map(creds.map((c) => [c.connectionId, c]));
      return conns.map((c) => this.toSanitizedView(c, credByConn.get(c.id)));
    });
  }

  async getConnectionById(
    connectionId: string,
  ): Promise<SanitizedChannelConnectionView> {
    const tenantId = TenantContext.require();
    return this.dataSource.transaction(async (em) => {
      await em.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        tenantId,
      ]);
      const conn = await em.getRepository(ChannelConnectionEntity).findOne({
        where: { id: connectionId, tenantId },
      });
      if (!conn) {
        throw new IntegrationDomainError(
          IntegrationDomainErrorCode.CHANNEL_CONNECTION_NOT_FOUND,
          `Channel connection ${connectionId} not found`,
          404,
        );
      }
      const cred = await em.getRepository(ConnectionCredentialEntity).findOne({
        where: { connectionId, tenantId },
      });
      return this.toSanitizedView(conn, cred ?? undefined);
    });
  }

  async authorizeConnection(
    connectionId: string,
    actorId: string,
    dto: AuthorizeChannelConnectionDto,
  ) {
    const tenantId = TenantContext.require();
    return this.dataSource.transaction(async (em) => {
      await em.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        tenantId,
      ]);
      const conn = await em.getRepository(ChannelConnectionEntity).findOne({
        where: { id: connectionId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!conn) {
        throw new IntegrationDomainError(
          IntegrationDomainErrorCode.CHANNEL_CONNECTION_NOT_FOUND,
          `Channel connection ${connectionId} not found`,
          404,
        );
      }
      const cred = await em.getRepository(ConnectionCredentialEntity).findOne({
        where: { connectionId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!cred) {
        throw new IntegrationDomainError(
          IntegrationDomainErrorCode.CHANNEL_AUTHORIZATION_FAILED,
          `Credentials record missing for connection ${connectionId}`,
          500,
        );
      }

      const adapter = this.providerRegistry.getAdapter(conn.provider);
      const partnerSecret = decryptCredentialSecret(
        cred.encryptedWebhookSecret,
      );
      const partnerId =
        cred.partnerId ?? `${conn.provider.toLowerCase()}-partner`;

      // Mode 1: Initiate OAuth redirect flow
      if (!dto.authorizationCode) {
        const stateNonce = `st_${conn.id.slice(0, 8)}_${randomBytes(12).toString('hex')}`;
        const redirectUri =
          dto.redirectUri ??
          `https://app.sapoclone.local/integrations/${conn.provider.toLowerCase()}/callback`;
        conn.oauthStateNonce = stateNonce;
        conn.oauthRedirectUri = redirectUri;
        conn.oauthInitiatedBy = actorId;
        await em.save(ChannelConnectionEntity, conn);

        const authUrl = adapter.buildAuthorizationUrl({
          connectionId: conn.id,
          externalShopId: conn.externalShopId,
          redirectUri,
          stateNonce,
          partnerId,
          partnerSecret,
        });
        return {
          mode: 'OAUTH_INITIATED',
          connectionId: conn.id,
          provider: conn.provider,
          ...authUrl,
        };
      }

      // Mode 2: Complete OAuth callback
      if (conn.oauthStateNonce && dto.stateNonce !== conn.oauthStateNonce) {
        throw new IntegrationDomainError(
          IntegrationDomainErrorCode.CHANNEL_AUTHORIZATION_FAILED,
          'OAuth callback state nonce mismatch (CSRF protection rejected callback)',
          401,
        );
      }

      if (
        dto.externalShopId &&
        dto.externalShopId.trim() !== conn.externalShopId
      ) {
        throw new IntegrationDomainError(
          IntegrationDomainErrorCode.CHANNEL_AUTHORIZATION_FAILED,
          `Returned shop identity (${dto.externalShopId}) does not match connection shop (${conn.externalShopId})`,
          409,
        );
      }

      assertValidConnectionTransition(conn.status, 'CONNECTED');
      const exchanged = await adapter.exchangeAuthorizationCode({
        connectionId: conn.id,
        code: dto.authorizationCode,
        externalShopId: conn.externalShopId,
        partnerId,
        partnerSecret,
      });

      const now = new Date();
      cred.encryptedAccessToken = encryptCredentialSecret(
        exchanged.accessToken,
      );
      cred.encryptedRefreshToken = encryptCredentialSecret(
        exchanged.refreshToken,
      );
      cred.accessTokenExpiresAt = exchanged.accessTokenExpiresAt;
      cred.refreshTokenExpiresAt = exchanged.refreshTokenExpiresAt;
      cred.scopes = exchanged.scopes.join(',');
      cred.credentialVersion += 1;
      cred.lastRefreshedAt = now;
      await em.save(ConnectionCredentialEntity, cred);

      conn.status = 'CONNECTED';
      conn.oauthStateNonce = null;
      conn.lastSyncAt = now;
      conn.lastErrorCode = null;
      conn.lastErrorMessage = null;
      conn.consecutiveFailures = 0;
      conn.version += 1;
      await em.save(ChannelConnectionEntity, conn);

      await em.save(
        IntegrationAuditLogEntity,
        em.create(IntegrationAuditLogEntity, {
          tenantId,
          connectionId: conn.id,
          actorId,
          action: 'CONNECTION_AUTHORIZED',
          targetType: 'CHANNEL_CONNECTION',
          targetId: conn.id,
          metadata: {
            provider: conn.provider,
            externalShopId: conn.externalShopId,
            credentialVersion: cred.credentialVersion,
          },
        }),
      );

      await this.outbox.enqueue(em, INTEGRATION_CONNECTION_CONNECTED, {
        tenantId,
        aggregateId: conn.id,
        actor: { id: actorId, type: 'account' },
        payload: {
          connectionId: conn.id,
          provider: conn.provider,
          externalShopId: conn.externalShopId,
          shopName: conn.shopName,
          branchId: conn.branchId,
          warehouseId: conn.warehouseId,
          status: conn.status,
          occurredAt: now.toISOString(),
        } satisfies IntegrationConnectionEventPayload,
      });

      return {
        mode: 'OAUTH_COMPLETED',
        connection: this.toSanitizedView(conn, cred),
      };
    });
  }

  /**
   * Concurrency-safe token refresh (Section 7 / Test H):
   * 1. Short DB transaction claims a refresh lease (without holding a DB transaction open during the provider call).
   * 2. If another worker already holds an active lease or already incremented `credential_version`, returns the latest state without duplicate refresh or overwriting newer tokens.
   * 3. Calls provider adapter `refreshAccessToken`.
   * 4. Second short DB transaction performs compare-and-swap on `credential_version` + `refresh_lease_owner`.
   */
  async refreshCredentials(
    connectionId: string,
    actorId: string,
    dto?: RefreshConnectionTokenDto,
  ): Promise<SanitizedChannelConnectionView & { refreshed: boolean }> {
    const tenantId = TenantContext.require();
    const leaseOwner = dto?.workerId ?? `worker-${randomUUID().slice(0, 8)}`;

    // Step 1: Acquire short refresh lease in Transaction 1
    const claim = await this.dataSource.transaction(async (em) => {
      await em.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        tenantId,
      ]);
      const conn = await em.getRepository(ChannelConnectionEntity).findOne({
        where: { id: connectionId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!conn) {
        throw new IntegrationDomainError(
          IntegrationDomainErrorCode.CHANNEL_CONNECTION_NOT_FOUND,
          `Channel connection ${connectionId} not found`,
          404,
        );
      }
      const cred = await em.getRepository(ConnectionCredentialEntity).findOne({
        where: { connectionId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!cred || !cred.encryptedRefreshToken) {
        throw new IntegrationDomainError(
          IntegrationDomainErrorCode.CHANNEL_REAUTH_REQUIRED,
          `Connection ${connectionId} has no refresh token; re-authorization required`,
          409,
        );
      }

      const now = new Date();
      // If another worker just refreshed within the last 2 seconds or holds an active lease, skip duplicate refresh
      if (
        cred.refreshLeaseOwner &&
        cred.refreshLeaseOwner !== leaseOwner &&
        cred.refreshLeaseExpiresAt &&
        cred.refreshLeaseExpiresAt.getTime() > now.getTime()
      ) {
        return {
          alreadyHandled: true as const,
          conn,
          cred,
        };
      }
      if (
        cred.lastRefreshedAt &&
        now.getTime() - cred.lastRefreshedAt.getTime() < 1500 &&
        cred.credentialVersion > 1
      ) {
        return {
          alreadyHandled: true as const,
          conn,
          cred,
        };
      }

      cred.refreshLeaseOwner = leaseOwner;
      cred.refreshLeaseExpiresAt = new Date(now.getTime() + 10_000);
      await em.save(ConnectionCredentialEntity, cred);

      return {
        alreadyHandled: false as const,
        conn,
        cred,
        expectedVersion: cred.credentialVersion,
        refreshToken: decryptCredentialSecret(cred.encryptedRefreshToken),
        partnerSecret: decryptCredentialSecret(cred.encryptedWebhookSecret),
        partnerId: cred.partnerId ?? `${conn.provider.toLowerCase()}-partner`,
      };
    });

    if (claim.alreadyHandled) {
      return {
        ...this.toSanitizedView(claim.conn, claim.cred),
        refreshed: false,
      };
    }

    const adapter = this.providerRegistry.getAdapter(claim.conn.provider);

    // Step 2: Call provider adapter OUTSIDE database transaction
    let refreshedTokens;
    try {
      refreshedTokens = await adapter.refreshAccessToken({
        connectionId: claim.conn.id,
        externalShopId: claim.conn.externalShopId,
        refreshToken: claim.refreshToken,
        partnerId: claim.partnerId,
        partnerSecret: claim.partnerSecret,
      });
    } catch (error) {
      // Transition to REAUTH_REQUIRED if refresh token is invalid/expired
      await this.dataSource.transaction(async (em) => {
        await em.query(`SELECT set_config('app.tenant_id', $1, true)`, [
          tenantId,
        ]);
        const conn = await em.getRepository(ChannelConnectionEntity).findOne({
          where: { id: connectionId, tenantId },
          lock: { mode: 'pessimistic_write' },
        });
        const cred = await em
          .getRepository(ConnectionCredentialEntity)
          .findOne({
            where: { connectionId, tenantId },
            lock: { mode: 'pessimistic_write' },
          });
        if (cred && cred.refreshLeaseOwner === leaseOwner) {
          cred.refreshLeaseOwner = null;
          cred.refreshLeaseExpiresAt = null;
          await em.save(ConnectionCredentialEntity, cred);
        }
        if (conn) {
          conn.status = 'REAUTH_REQUIRED';
          conn.lastErrorCode =
            error instanceof IntegrationDomainError
              ? error.code
              : 'TOKEN_REFRESH_FAILED';
          conn.lastErrorMessage =
            error instanceof Error ? error.message : String(error);
          await em.save(ChannelConnectionEntity, conn);
          await this.outbox.enqueue(
            em,
            INTEGRATION_CONNECTION_REAUTH_REQUIRED,
            {
              tenantId,
              aggregateId: conn.id,
              actor: { id: actorId, type: 'account' },
              payload: {
                connectionId: conn.id,
                provider: conn.provider,
                externalShopId: conn.externalShopId,
                shopName: conn.shopName,
                branchId: conn.branchId,
                warehouseId: conn.warehouseId,
                status: conn.status,
                reason: conn.lastErrorMessage,
                occurredAt: new Date().toISOString(),
              } satisfies IntegrationConnectionEventPayload,
            },
          );
        }
      });
      throw error;
    }

    // Step 3: Compare-and-swap on credential_version in Transaction 2
    return this.dataSource.transaction(async (em) => {
      await em.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        tenantId,
      ]);
      const conn = await em.getRepository(ChannelConnectionEntity).findOne({
        where: { id: connectionId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      const cred = await em.getRepository(ConnectionCredentialEntity).findOne({
        where: { connectionId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!conn || !cred) {
        throw new IntegrationDomainError(
          IntegrationDomainErrorCode.CHANNEL_CONNECTION_NOT_FOUND,
          `Connection ${connectionId} disappeared during token refresh`,
          404,
        );
      }

      // Guard against stale overwrite if another process already bumped credentialVersion
      if (cred.credentialVersion !== claim.expectedVersion) {
        return {
          ...this.toSanitizedView(conn, cred),
          refreshed: false,
        };
      }

      const now = new Date();
      cred.encryptedAccessToken = encryptCredentialSecret(
        refreshedTokens.accessToken,
      );
      cred.encryptedRefreshToken = encryptCredentialSecret(
        refreshedTokens.refreshToken,
      );
      cred.accessTokenExpiresAt = refreshedTokens.accessTokenExpiresAt;
      cred.refreshTokenExpiresAt = refreshedTokens.refreshTokenExpiresAt;
      cred.credentialVersion += 1;
      cred.lastRefreshedAt = now;
      cred.refreshLeaseOwner = null;
      cred.refreshLeaseExpiresAt = null;
      await em.save(ConnectionCredentialEntity, cred);

      if (
        conn.status === 'TOKEN_EXPIRED' ||
        conn.status === 'DEGRADED' ||
        conn.status === 'REAUTH_REQUIRED'
      ) {
        conn.status = 'CONNECTED';
      }
      conn.lastErrorCode = null;
      conn.lastErrorMessage = null;
      conn.version += 1;
      await em.save(ChannelConnectionEntity, conn);

      await em.save(
        IntegrationAuditLogEntity,
        em.create(IntegrationAuditLogEntity, {
          tenantId,
          connectionId: conn.id,
          actorId,
          action: 'CREDENTIALS_REFRESHED',
          targetType: 'CHANNEL_CONNECTION',
          targetId: conn.id,
          metadata: {
            credentialVersion: cred.credentialVersion,
          },
        }),
      );

      return {
        ...this.toSanitizedView(conn, cred),
        refreshed: true,
      };
    });
  }

  async pauseConnection(
    connectionId: string,
    actorId: string,
  ): Promise<SanitizedChannelConnectionView> {
    return this.transitionConnectionState(connectionId, actorId, 'PAUSED');
  }

  async resumeConnection(
    connectionId: string,
    actorId: string,
  ): Promise<SanitizedChannelConnectionView> {
    return this.transitionConnectionState(connectionId, actorId, 'CONNECTED');
  }

  async disconnectConnection(
    connectionId: string,
    actorId: string,
  ): Promise<SanitizedChannelConnectionView> {
    return this.transitionConnectionState(
      connectionId,
      actorId,
      'DISCONNECTED',
    );
  }

  async getConnectionHealth(connectionId: string) {
    const view = await this.getConnectionById(connectionId);
    const circuit = this.rateLimiter.getCircuitState(view.provider, view.id);
    const capabilities = this.providerRegistry
      .getAdapter(view.provider)
      .getCapabilities();
    const nowMs = Date.now();
    const tokenExpiresAtMs = view.credentialSummary.accessTokenExpiresAt
      ? new Date(view.credentialSummary.accessTokenExpiresAt).getTime()
      : null;

    return {
      connectionId: view.id,
      provider: view.provider,
      externalShopId: view.externalShopId,
      status: view.status,
      healthy:
        view.status === 'CONNECTED' &&
        circuit.state === 'CLOSED' &&
        (tokenExpiresAtMs === null || tokenExpiresAtMs > nowMs),
      circuitBreaker: circuit,
      tokenStatus: {
        hasAccessToken: view.credentialSummary.hasAccessToken,
        accessTokenExpiresAt: view.credentialSummary.accessTokenExpiresAt,
        isExpired:
          tokenExpiresAtMs !== null ? tokenExpiresAtMs <= nowMs : false,
      },
      lastSyncAt: view.lastSyncAt,
      lastOrderSyncAt: view.lastOrderSyncAt,
      lastInventorySyncAt: view.lastInventorySyncAt,
      consecutiveFailures: view.consecutiveFailures,
      lastErrorCode: view.lastErrorCode,
      capabilities,
    };
  }

  /**
   * Internal-only helper for workers/adapters. Never called directly by public HTTP controllers.
   */
  async getDecryptedCredentialsForWorker(
    tenantId: string,
    connectionId: string,
  ): Promise<DecryptedConnectionCredentials> {
    return this.dataSource.transaction(async (em) => {
      await em.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        tenantId,
      ]);
      const conn = await em.getRepository(ChannelConnectionEntity).findOne({
        where: { id: connectionId, tenantId },
      });
      if (!conn) {
        throw new IntegrationDomainError(
          IntegrationDomainErrorCode.CHANNEL_CONNECTION_NOT_FOUND,
          `Connection ${connectionId} not found`,
          404,
        );
      }
      if (conn.status === 'DISCONNECTED' || conn.status === 'PAUSED') {
        throw new IntegrationDomainError(
          IntegrationDomainErrorCode.CHANNEL_CONNECTION_INACTIVE,
          `Connection ${connectionId} is ${conn.status}`,
          409,
        );
      }
      const cred = await em.getRepository(ConnectionCredentialEntity).findOne({
        where: { connectionId, tenantId },
      });
      if (!cred) {
        throw new IntegrationDomainError(
          IntegrationDomainErrorCode.CHANNEL_AUTHORIZATION_FAILED,
          `Credentials missing for connection ${connectionId}`,
          409,
        );
      }

      return {
        connection: conn,
        credentialVersion: cred.credentialVersion,
        accessToken: cred.encryptedAccessToken
          ? decryptCredentialSecret(cred.encryptedAccessToken)
          : '',
        refreshToken: cred.encryptedRefreshToken
          ? decryptCredentialSecret(cred.encryptedRefreshToken)
          : null,
        webhookSecret: decryptCredentialSecret(cred.encryptedWebhookSecret),
        partnerId: cred.partnerId,
      };
    });
  }

  private async transitionConnectionState(
    connectionId: string,
    actorId: string,
    targetStatus: ConnectionStatus,
  ): Promise<SanitizedChannelConnectionView> {
    const tenantId = TenantContext.require();
    return this.dataSource.transaction(async (em) => {
      await em.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        tenantId,
      ]);
      const conn = await em.getRepository(ChannelConnectionEntity).findOne({
        where: { id: connectionId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!conn) {
        throw new IntegrationDomainError(
          IntegrationDomainErrorCode.CHANNEL_CONNECTION_NOT_FOUND,
          `Channel connection ${connectionId} not found`,
          404,
        );
      }

      assertValidConnectionTransition(conn.status, targetStatus);
      conn.status = targetStatus;
      conn.version += 1;
      await em.save(ChannelConnectionEntity, conn);

      const cred = await em.getRepository(ConnectionCredentialEntity).findOne({
        where: { connectionId, tenantId },
      });

      if (targetStatus === 'DISCONNECTED' && cred) {
        cred.encryptedAccessToken = null;
        cred.encryptedRefreshToken = null;
        cred.credentialVersion += 1;
        await em.save(ConnectionCredentialEntity, cred);

        await this.outbox.enqueue(em, INTEGRATION_CONNECTION_DISCONNECTED, {
          tenantId,
          aggregateId: conn.id,
          actor: { id: actorId, type: 'account' },
          payload: {
            connectionId: conn.id,
            provider: conn.provider,
            externalShopId: conn.externalShopId,
            shopName: conn.shopName,
            branchId: conn.branchId,
            warehouseId: conn.warehouseId,
            status: conn.status,
            occurredAt: new Date().toISOString(),
          } satisfies IntegrationConnectionEventPayload,
        });
      }

      await em.save(
        IntegrationAuditLogEntity,
        em.create(IntegrationAuditLogEntity, {
          tenantId,
          connectionId: conn.id,
          actorId,
          action: `CONNECTION_${targetStatus}`,
          targetType: 'CHANNEL_CONNECTION',
          targetId: conn.id,
          metadata: { status: targetStatus },
        }),
      );

      return this.toSanitizedView(conn, cred ?? undefined);
    });
  }

  private toSanitizedView(
    conn: ChannelConnectionEntity,
    cred?: ConnectionCredentialEntity,
  ): SanitizedChannelConnectionView {
    return {
      id: conn.id,
      tenantId: conn.tenantId,
      code: conn.code,
      provider: conn.provider,
      connectionKey: conn.connectionKey,
      externalShopId: conn.externalShopId,
      shopName: conn.shopName,
      branchId: conn.branchId,
      warehouseId: conn.warehouseId,
      status: conn.status,
      safetyStockBuffer: conn.safetyStockBuffer,
      stockAllocationPercent: conn.stockAllocationPercent,
      lastSyncAt: conn.lastSyncAt ? conn.lastSyncAt.toISOString() : null,
      lastOrderSyncAt: conn.lastOrderSyncAt
        ? conn.lastOrderSyncAt.toISOString()
        : null,
      lastInventorySyncAt: conn.lastInventorySyncAt
        ? conn.lastInventorySyncAt.toISOString()
        : null,
      lastErrorCode: conn.lastErrorCode,
      lastErrorMessage: conn.lastErrorMessage,
      consecutiveFailures: conn.consecutiveFailures,
      credentialSummary: {
        credentialVersion: cred?.credentialVersion ?? 0,
        hasAccessToken: Boolean(cred?.encryptedAccessToken),
        hasRefreshToken: Boolean(cred?.encryptedRefreshToken),
        accessTokenExpiresAt: cred?.accessTokenExpiresAt
          ? cred.accessTokenExpiresAt.toISOString()
          : null,
        refreshTokenExpiresAt: cred?.refreshTokenExpiresAt
          ? cred.refreshTokenExpiresAt.toISOString()
          : null,
        lastRefreshedAt: cred?.lastRefreshedAt
          ? cred.lastRefreshedAt.toISOString()
          : null,
      },
      createdAt: conn.createdAt.toISOString(),
      updatedAt: conn.updatedAt.toISOString(),
    };
  }
}
