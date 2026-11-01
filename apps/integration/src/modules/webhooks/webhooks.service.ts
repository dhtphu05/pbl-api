import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import {
  IntegrationDomainError,
  IntegrationDomainErrorCode,
  MarketplaceProvider,
  decryptCredentialSecret,
  encryptCredentialSecret,
} from '../../domain/integration-domain';
import {
  ChannelConnectionEntity,
  ConnectionCredentialEntity,
  IntegrationAuditLogEntity,
  WebhookInboxEventEntity,
} from '../../infrastructure/persistence/integration.entities';
import { ProviderRegistryService } from '../../providers/provider-registry.service';
import { SyncJobsService } from '../sync-jobs/sync-jobs.service';

export interface WebhookIngestionInput {
  provider: string;
  connectionKey: string;
  webhookUrl: string;
  rawBody: Buffer | string;
  headers: Record<string, string | string[] | undefined>;
  nowMs?: number;
  processSynchronously?: boolean;
}

export interface WebhookIngestionResult {
  acknowledged: boolean;
  deduplicated: boolean;
  inboxEventId: string;
  syncJobId: string | null;
  eventType: string;
  externalOrderId: string | null;
}

@Injectable()
export class WebhooksService {
  private simulatePersistenceFailureForConnection = new Set<string>();

  constructor(
    private readonly dataSource: DataSource,
    private readonly providerRegistry: ProviderRegistryService,
    private readonly syncJobsService: SyncJobsService,
  ) {}

  injectPersistenceFailure(connectionKey: string, enabled: boolean): void {
    if (enabled) {
      this.simulatePersistenceFailureForConnection.add(connectionKey);
    } else {
      this.simulatePersistenceFailureForConnection.delete(connectionKey);
    }
  }

  async ingestWebhook(
    input: WebhookIngestionInput,
  ): Promise<WebhookIngestionResult> {
    const normalizedProvider = input.provider
      ?.trim()
      .toUpperCase() as MarketplaceProvider;
    if (normalizedProvider !== 'SHOPEE' && normalizedProvider !== 'LAZADA') {
      throw new IntegrationDomainError(
        IntegrationDomainErrorCode.PROVIDER_CAPABILITY_UNSUPPORTED,
        `Unsupported webhook provider "${input.provider}"`,
        400,
      );
    }

    const rawBuffer = Buffer.isBuffer(input.rawBody)
      ? input.rawBody
      : Buffer.from(String(input.rawBody ?? ''), 'utf8');

    // Bounded payload check (max 256 KB)
    if (rawBuffer.length === 0 || rawBuffer.length > 262_144) {
      throw new IntegrationDomainError(
        IntegrationDomainErrorCode.WEBHOOK_PAYLOAD_UNSUPPORTED,
        `Webhook payload size (${rawBuffer.length} bytes) is outside allowed bounds (1..262144 bytes)`,
        413,
      );
    }

    // Step 1: Resolve connection by connectionKey via dedicated RLS select policy
    const resolved = await this.dataSource.transaction(async (em) => {
      await em.query(
        `SELECT set_config('app.webhook_connection_key', $1, true)`,
        [input.connectionKey.trim()],
      );
      const conn = await em.getRepository(ChannelConnectionEntity).findOne({
        where: {
          connectionKey: input.connectionKey.trim(),
          provider: normalizedProvider,
        },
      });
      if (!conn) {
        throw new IntegrationDomainError(
          IntegrationDomainErrorCode.CHANNEL_CONNECTION_NOT_FOUND,
          'Unknown webhook routing connection key',
          404,
        );
      }

      // Now bind tenant context strictly from the trusted connection row
      await em.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        conn.tenantId,
      ]);

      const cred = await em.getRepository(ConnectionCredentialEntity).findOne({
        where: {
          tenantId: conn.tenantId,
          connectionId: conn.id,
        },
      });
      if (!cred) {
        throw new IntegrationDomainError(
          IntegrationDomainErrorCode.CHANNEL_AUTHORIZATION_FAILED,
          'Connection credentials not configured',
          401,
        );
      }

      return {
        conn,
        webhookSecret: decryptCredentialSecret(cred.encryptedWebhookSecret),
      };
    });

    if (
      resolved.conn.status === 'DISCONNECTED' ||
      resolved.conn.status === 'PAUSED'
    ) {
      throw new IntegrationDomainError(
        IntegrationDomainErrorCode.CHANNEL_CONNECTION_INACTIVE,
        `Channel connection ${resolved.conn.code} is ${resolved.conn.status}`,
        409,
      );
    }

    const adapter = this.providerRegistry.getAdapter(normalizedProvider);

    // Step 2: Verify cryptographic signature & replay window
    let envelope;
    try {
      envelope = adapter.verifyAndParseWebhook({
        webhookUrl: input.webhookUrl,
        rawBody: rawBuffer,
        headers: input.headers,
        webhookSecret: resolved.webhookSecret,
        nowMs: input.nowMs,
      });
    } catch (error) {
      // Record security audit event without leaking secret material
      await this.dataSource.transaction(async (em) => {
        await em.query(`SELECT set_config('app.tenant_id', $1, true)`, [
          resolved.conn.tenantId,
        ]);
        await em.save(
          IntegrationAuditLogEntity,
          em.create(IntegrationAuditLogEntity, {
            tenantId: resolved.conn.tenantId,
            connectionId: resolved.conn.id,
            actorId: 'external-webhook',
            action: 'WEBHOOK_VERIFICATION_REJECTED',
            targetType: 'CHANNEL_CONNECTION',
            targetId: resolved.conn.id,
            metadata: {
              provider: normalizedProvider,
              errorCode:
                error instanceof IntegrationDomainError
                  ? error.code
                  : 'INVALID_WEBHOOK',
            },
          }),
        );
      });
      throw error;
    }

    // Step 3: Validate shop identity matches connection
    if (envelope.externalShopId !== resolved.conn.externalShopId) {
      throw new IntegrationDomainError(
        IntegrationDomainErrorCode.INVALID_WEBHOOK_SIGNATURE,
        `Webhook shop identity (${envelope.externalShopId}) does not match connection shop (${resolved.conn.externalShopId})`,
        401,
      );
    }

    // Fault-injection check for Test F (Webhook persistence failure)
    if (this.simulatePersistenceFailureForConnection.has(input.connectionKey)) {
      throw new IntegrationDomainError(
        IntegrationDomainErrorCode.WEBHOOK_PERSISTENCE_FAILED,
        'Durable webhook persistence failed; returning 503 so provider retries delivery',
        503,
      );
    }

    const tenantId = resolved.conn.tenantId;
    const payloadHash = createHash('sha256').update(rawBuffer).digest('hex');

    // Step 4: Durable inbox persistence + work-dispatch inside transaction
    const persisted = await this.dataSource.transaction(async (em) => {
      await em.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        tenantId,
      ]);
      await em.query(
        `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
        [tenantId, `wh-dedup:${resolved.conn.id}:${envelope.deduplicationKey}`],
      );

      const existing = await em.getRepository(WebhookInboxEventEntity).findOne({
        where: {
          tenantId,
          connectionId: resolved.conn.id,
          deduplicationKey: envelope.deduplicationKey,
        },
      });
      if (existing) {
        return {
          deduplicated: true,
          inboxEvent: existing,
        };
      }

      const inboxEvent = em.create(WebhookInboxEventEntity, {
        id: randomUUID(),
        tenantId,
        connectionId: resolved.conn.id,
        provider: normalizedProvider,
        externalEventId: envelope.externalEventId,
        deduplicationKey: envelope.deduplicationKey,
        eventType: envelope.eventType,
        externalShopId: envelope.externalShopId,
        externalOrderId: envelope.externalOrderId,
        payloadHash,
        encryptedPayload: encryptCredentialSecret(rawBuffer.toString('utf8')),
        providerEventTime: envelope.providerEventTime,
        processingStatus: 'VALIDATED',
        attemptCount: 0,
        lastErrorCategory: null,
        lastError: null,
        processedAt: null,
      });
      await em.save(WebhookInboxEventEntity, inboxEvent);

      return {
        deduplicated: false,
        inboxEvent,
      };
    });

    if (persisted.deduplicated) {
      return {
        acknowledged: true,
        deduplicated: true,
        inboxEventId: persisted.inboxEvent.id,
        syncJobId: null,
        eventType: persisted.inboxEvent.eventType,
        externalOrderId: persisted.inboxEvent.externalOrderId,
      };
    }

    // Step 5: Enqueue durable SyncJob for asynchronous business processing
    let syncJobId: string | null = null;
    if (
      (envelope.eventType === 'ORDER_STATUS_UPDATE' ||
        envelope.eventType === 'ORDER_CREATED' ||
        envelope.eventType === 'ORDER_CANCELLED') &&
      envelope.externalOrderId
    ) {
      const dataObj = envelope.parsedPayload.data as any;
      const inlineOrder =
        dataObj?.order_detail ??
        (envelope.parsedPayload as any).order_detail ??
        (Array.isArray(dataObj?.item_list) ||
        Array.isArray(dataObj?.order_items) ||
        Array.isArray(dataObj?.lines)
          ? dataObj
          : undefined);

      const enqueued = await this.syncJobsService.enqueueSyncJob({
        tenantId,
        connectionId: resolved.conn.id,
        jobType: 'ORDER_IMPORT',
        idempotencyKey: `wh-job:${resolved.conn.id}:${envelope.deduplicationKey}`,
        payload: {
          inboxEventId: persisted.inboxEvent.id,
          externalOrderId: envelope.externalOrderId,
          externalStatus: envelope.externalStatus,
          ...(inlineOrder ? { rawOrder: inlineOrder } : {}),
        },
      });
      syncJobId = enqueued.job.id;

      if (input.processSynchronously) {
        await this.syncJobsService.executeJobById(
          tenantId,
          syncJobId,
          'webhook-inline-worker',
        );
      }

      await this.dataSource.transaction(async (em) => {
        await em.query(`SELECT set_config('app.tenant_id', $1, true)`, [
          tenantId,
        ]);
        await em.update(
          WebhookInboxEventEntity,
          { id: persisted.inboxEvent.id, tenantId },
          {
            processingStatus: input.processSynchronously
              ? 'PROCESSED'
              : 'PROCESSING',
            processedAt: input.processSynchronously ? new Date() : null,
          },
        );
      });
    } else if (envelope.eventType === 'AUTH_EXPIRED') {
      const enqueued = await this.syncJobsService.enqueueSyncJob({
        tenantId,
        connectionId: resolved.conn.id,
        jobType: 'CONNECTION_TOKEN_REFRESH',
        idempotencyKey: `wh-auth:${resolved.conn.id}:${envelope.deduplicationKey}`,
        payload: { inboxEventId: persisted.inboxEvent.id },
      });
      syncJobId = enqueued.job.id;
    } else {
      // Unknown or diagnostic event type: record as NEEDS_REVIEW without discarding
      await this.dataSource.transaction(async (em) => {
        await em.query(`SELECT set_config('app.tenant_id', $1, true)`, [
          tenantId,
        ]);
        await em.update(
          WebhookInboxEventEntity,
          { id: persisted.inboxEvent.id, tenantId },
          {
            processingStatus: 'NEEDS_REVIEW',
            lastError: `Unhandled webhook eventType ${envelope.eventType}`,
          },
        );
      });
    }

    return {
      acknowledged: true,
      deduplicated: false,
      inboxEventId: persisted.inboxEvent.id,
      syncJobId,
      eventType: envelope.eventType,
      externalOrderId: envelope.externalOrderId,
    };
  }
}
