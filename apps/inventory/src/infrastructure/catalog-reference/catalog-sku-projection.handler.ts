import { Injectable, Logger } from '@nestjs/common';
import { EventEnvelope } from '@pbl/common';
import {
  CATALOG_PRODUCT_DEACTIVATED,
  CATALOG_VARIANT_CREATED,
  CATALOG_VARIANT_DEACTIVATED,
  CATALOG_VARIANT_UPDATED,
  CatalogProductEventPayload,
  CatalogVariantEventPayload,
} from '@pbl/contracts';
import { OnEvent, qualifiedTable } from '@pbl/events';
import { randomUUID } from 'crypto';
import { EntityManager } from 'typeorm';
import {
  InventoryDomainError,
  InventoryDomainErrorCode,
} from '../../domain/inventory-domain';

/**
 * Maintains Inventory's local SKU reference projection (`catalog_sku_projection`)
 * from Catalog M1 outbox events without ever querying or joining the `catalog` schema.
 * Handles duplicates and out-of-order events using `aggregate_version` / `source_updated_at`.
 */
@Injectable()
export class CatalogSkuProjectionHandler {
  private readonly logger = new Logger(CatalogSkuProjectionHandler.name);

  @OnEvent(CATALOG_VARIANT_CREATED.type)
  onVariantCreated(
    event: EventEnvelope<CatalogVariantEventPayload>,
    manager: EntityManager,
  ): Promise<void> {
    return this.upsertVariantProjection(event, manager);
  }

  @OnEvent(CATALOG_VARIANT_UPDATED.type)
  onVariantUpdated(
    event: EventEnvelope<CatalogVariantEventPayload>,
    manager: EntityManager,
  ): Promise<void> {
    return this.upsertVariantProjection(event, manager);
  }

  @OnEvent(CATALOG_VARIANT_DEACTIVATED.type)
  onVariantDeactivated(
    event: EventEnvelope<CatalogVariantEventPayload>,
    manager: EntityManager,
  ): Promise<void> {
    return this.upsertVariantProjection(event, manager);
  }

  @OnEvent(CATALOG_PRODUCT_DEACTIVATED.type)
  async onProductDeactivated(
    event: EventEnvelope<CatalogProductEventPayload>,
    manager: EntityManager,
  ): Promise<void> {
    await manager.query(`SELECT set_config('app.tenant_id', $1, true)`, [
      event.tenantId,
    ]);
    const table = qualifiedTable(manager.connection, 'catalog_sku_projection');
    await manager.query(
      `
      UPDATE ${table}
      SET
        status = 'INACTIVE',
        source_updated_at = $3::timestamptz,
        synced_at = now()
      WHERE tenant_id = $1
        AND product_id = $2
        AND source_updated_at <= $3::timestamptz
      `,
      [event.tenantId, event.payload.productId, event.payload.updatedAt],
    );
  }

  private async upsertVariantProjection(
    event: EventEnvelope<CatalogVariantEventPayload>,
    manager: EntityManager,
  ): Promise<void> {
    await manager.query(`SELECT set_config('app.tenant_id', $1, true)`, [
      event.tenantId,
    ]);
    const table = qualifiedTable(manager.connection, 'catalog_sku_projection');
    const p = event.payload;

    const existingRows = await manager.query(
      `
      SELECT aggregate_version AS "aggregateVersion", source_updated_at AS "sourceUpdatedAt"
      FROM ${table}
      WHERE tenant_id = $1 AND sku_id = $2
      LIMIT 1
      `,
      [event.tenantId, p.variantId],
    );

    if (existingRows.length > 0) {
      const existing = existingRows[0];
      const existingVersion = Number(existing.aggregateVersion);
      const existingTime = new Date(existing.sourceUpdatedAt).getTime();
      const incomingTime = new Date(p.updatedAt).getTime();
      if (
        existingVersion > p.aggregateVersion ||
        (existingVersion === p.aggregateVersion && existingTime > incomingTime)
      ) {
        this.logger.debug(
          `Ignoring stale catalog variant event for sku_id=${p.variantId} (v${p.aggregateVersion} < v${existingVersion})`,
        );
        return;
      }
    }

    await manager.query(
      `
      INSERT INTO ${table} (
        id, tenant_id, sku_id, product_id, sku_code, name, status,
        aggregate_version, source_updated_at, synced_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, now())
      ON CONFLICT (tenant_id, sku_id) DO UPDATE SET
        product_id = EXCLUDED.product_id,
        sku_code = EXCLUDED.sku_code,
        name = EXCLUDED.name,
        status = EXCLUDED.status,
        aggregate_version = EXCLUDED.aggregate_version,
        source_updated_at = EXCLUDED.source_updated_at,
        synced_at = now()
      `,
      [
        randomUUID(),
        event.tenantId,
        p.variantId,
        p.productId,
        p.skuCode ?? (p as unknown as { sku?: string }).sku ?? 'UNKNOWN-SKU',
        p.name,
        p.status,
        p.aggregateVersion ?? 1,
        p.updatedAt ?? new Date().toISOString(),
      ],
    );
  }
}

/**
 * Validates that a SKU reference is active if it has been projected from Catalog.
 * If requireProjected is true, also throws SKU_NOT_FOUND when the SKU is missing from the projection.
 */
export async function assertCatalogSkuEligible(
  em: EntityManager,
  prefix: string,
  tenantId: string,
  skuId: string,
  requireProjected = false,
): Promise<string> {
  const rows = await em.query(
    `
    SELECT sku_id AS "skuId", status, sku_code AS "skuCode"
    FROM ${prefix}"catalog_sku_projection"
    WHERE tenant_id = $1 AND (sku_id::text = $2 OR sku_code = $2)
    LIMIT 1
    `,
    [tenantId, skuId],
  );
  if (rows.length === 0) {
    if (requireProjected) {
      throw new InventoryDomainError(
        InventoryDomainErrorCode.SKU_NOT_FOUND,
        `SKU ${skuId} not found in Catalog projection`,
        404,
      );
    }
    return skuId;
  }
  if (rows[0].status !== 'ACTIVE') {
    throw new InventoryDomainError(
      InventoryDomainErrorCode.SKU_NOT_SELLABLE,
      `SKU ${skuId} (${rows[0].skuCode}) has status ${rows[0].status} and is not eligible for stock operations`,
      409,
    );
  }
  return String(rows[0].skuId);
}
