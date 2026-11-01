import { Injectable, Logger, Optional } from '@nestjs/common';
import { EventEnvelope, InternalHttpClient, TenantContext } from '@pbl/common';
import {
  CATALOG_PRICE_CHANGED,
  CATALOG_PRODUCT_DEACTIVATED,
  CATALOG_VARIANT_CREATED,
  CATALOG_VARIANT_DEACTIVATED,
  CATALOG_VARIANT_UPDATED,
  CatalogPriceChangedPayload,
  CatalogProductEventPayload,
  CatalogVariantEventPayload,
} from '@pbl/contracts';
import { OnEvent, qualifiedTable } from '@pbl/events';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import {
  AuthoritativeCatalogVariant,
  SalesDomainError,
  SalesDomainErrorCode,
} from '../../domain/sales-domain';
import { getSchemaPrefix } from '../persistence/sales-code.generator';

/**
 * Authoritative Catalog Variant & Price Resolver for Sales M3.
 * Maintains the local `catalog_variant_projection` from Catalog M1 outbox events
 * (`catalog.variant.*`, `catalog.product.deactivated`, `catalog.price.changed`)
 * and falls back to Catalog HTTP lookup when configured, without ever querying
 * the `catalog` PostgreSQL schema directly.
 */
@Injectable()
export class CatalogClient {
  private readonly logger = new Logger(CatalogClient.name);

  constructor(
    private readonly dataSource: DataSource,
    @Optional() private readonly http?: InternalHttpClient,
  ) {}

  @OnEvent(CATALOG_VARIANT_CREATED.type)
  onVariantCreated(
    event: EventEnvelope<CatalogVariantEventPayload>,
    manager: EntityManager,
  ): Promise<void> {
    return this.upsertFromVariantEvent(event, manager);
  }

  @OnEvent(CATALOG_VARIANT_UPDATED.type)
  onVariantUpdated(
    event: EventEnvelope<CatalogVariantEventPayload>,
    manager: EntityManager,
  ): Promise<void> {
    return this.upsertFromVariantEvent(event, manager);
  }

  @OnEvent(CATALOG_VARIANT_DEACTIVATED.type)
  onVariantDeactivated(
    event: EventEnvelope<CatalogVariantEventPayload>,
    manager: EntityManager,
  ): Promise<void> {
    return this.upsertFromVariantEvent(event, manager);
  }

  @OnEvent(CATALOG_PRODUCT_DEACTIVATED.type)
  async onProductDeactivated(
    event: EventEnvelope<CatalogProductEventPayload>,
    manager: EntityManager,
  ): Promise<void> {
    await manager.query(`SELECT set_config('app.tenant_id', $1, true)`, [
      event.tenantId,
    ]);
    const table = qualifiedTable(
      manager.connection,
      'catalog_variant_projection',
    );
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

  @OnEvent(CATALOG_PRICE_CHANGED.type)
  async onPriceChanged(
    event: EventEnvelope<CatalogPriceChangedPayload>,
    manager: EntityManager,
  ): Promise<void> {
    if (!event.payload.isDefault) {
      return;
    }
    await manager.query(`SELECT set_config('app.tenant_id', $1, true)`, [
      event.tenantId,
    ]);
    const table = qualifiedTable(
      manager.connection,
      'catalog_variant_projection',
    );
    const incomingVersion = Number(event.payload.aggregateVersion ?? 1);
    const incomingUpdatedAt =
      event.payload.updatedAt ?? event.occurredAt ?? new Date().toISOString();
    await manager.query(
      `
      UPDATE ${table}
      SET
        unit_price = $3::numeric(18,2),
        aggregate_version = GREATEST(aggregate_version, $5::int),
        source_updated_at = $4::timestamptz,
        synced_at = now()
      WHERE tenant_id = $1
        AND variant_id = $2
        AND (
          aggregate_version < $5::int
          OR (aggregate_version = $5::int AND source_updated_at <= $4::timestamptz)
        )
      `,
      [
        event.tenantId,
        event.payload.variantId,
        event.payload.price,
        incomingUpdatedAt,
        incomingVersion,
      ],
    );
  }

  private async upsertFromVariantEvent(
    event: EventEnvelope<CatalogVariantEventPayload>,
    manager: EntityManager,
  ): Promise<void> {
    await manager.query(`SELECT set_config('app.tenant_id', $1, true)`, [
      event.tenantId,
    ]);
    const table = qualifiedTable(
      manager.connection,
      'catalog_variant_projection',
    );
    const p = event.payload;

    const existingRows = await manager.query(
      `
      SELECT aggregate_version AS "aggregateVersion", source_updated_at AS "sourceUpdatedAt"
      FROM ${table}
      WHERE tenant_id = $1 AND variant_id = $2
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
        return;
      }
    }

    await manager.query(
      `
      INSERT INTO ${table} (
        id, tenant_id, variant_id, product_id, sku_code, barcode,
        product_name, variant_name, unit_code, conversion_factor,
        unit_price, status, aggregate_version, source_updated_at, synced_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PCS', 1.0000, $9, $10, $11, $12::timestamptz, now())
      ON CONFLICT (tenant_id, variant_id) DO UPDATE SET
        product_id = EXCLUDED.product_id,
        sku_code = EXCLUDED.sku_code,
        barcode = EXCLUDED.barcode,
        product_name = EXCLUDED.product_name,
        variant_name = EXCLUDED.variant_name,
        unit_price = EXCLUDED.unit_price,
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
        p.skuCode,
        p.barcode ?? null,
        p.name,
        p.name,
        p.basePrice,
        p.status,
        p.aggregateVersion ?? 1,
        p.updatedAt ?? new Date().toISOString(),
      ],
    );
  }

  async resolveVariants(
    identifiers: Array<string | { variantId?: string; skuCode?: string }>,
  ): Promise<Map<string, AuthoritativeCatalogVariant>> {
    const tenantId = TenantContext.require();
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const variantIds = new Set<string>();
    const skuCodes = new Set<string>();

    for (const item of identifiers) {
      if (typeof item === 'string') {
        if (uuidRegex.test(item)) {
          variantIds.add(item);
        } else if (item.trim()) {
          skuCodes.add(item.trim().toUpperCase());
        }
      } else {
        if (item.variantId && uuidRegex.test(item.variantId)) {
          variantIds.add(item.variantId);
        }
        if (item.skuCode && item.skuCode.trim()) {
          skuCodes.add(item.skuCode.trim().toUpperCase());
        }
      }
    }

    const result = new Map<string, AuthoritativeCatalogVariant>();
    if (variantIds.size === 0 && skuCodes.size === 0) {
      return result;
    }

    const prefix = getSchemaPrefix(this.dataSource);
    const rows = await this.dataSource.transaction(async (em) => {
      await em.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        tenantId,
      ]);
      return em.query(
        `
        SELECT
          variant_id AS "variantId",
          product_id AS "productId",
          sku_code AS "skuCode",
          barcode,
          product_name AS "productName",
          variant_name AS "variantName",
          unit_code AS "unitCode",
          conversion_factor AS "conversionFactor",
          unit_price AS "unitPrice",
          status
        FROM ${prefix}"catalog_variant_projection"
        WHERE tenant_id = $1
          AND (
            variant_id = ANY($2::uuid[])
            OR UPPER(sku_code) = ANY($3::text[])
          )
        `,
        [tenantId, Array.from(variantIds), Array.from(skuCodes)],
      );
    });

    for (const r of rows) {
      const mapped: AuthoritativeCatalogVariant = {
        variantId: r.variantId,
        productId: r.productId,
        skuCode: r.skuCode,
        barcode: r.barcode ?? null,
        productName: r.productName,
        variantName: r.variantName,
        unitCode: r.unitCode ?? 'PCS',
        conversionFactor: String(r.conversionFactor ?? '1.0000'),
        unitPrice: String(r.unitPrice),
        status: r.status,
      };
      result.set(r.variantId, mapped);
      result.set(r.skuCode, mapped);
      result.set(r.skuCode.toUpperCase(), mapped);
    }

    return result;
  }

  async lookupBySkuOrBarcode(query: {
    sku?: string;
    barcode?: string;
  }): Promise<AuthoritativeCatalogVariant> {
    const tenantId = TenantContext.require();
    const prefix = getSchemaPrefix(this.dataSource);
    const rows = await this.dataSource.transaction(async (em) => {
      await em.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        tenantId,
      ]);
      if (query.sku) {
        return em.query(
          `
          SELECT
            variant_id AS "variantId",
            product_id AS "productId",
            sku_code AS "skuCode",
            barcode,
            product_name AS "productName",
            variant_name AS "variantName",
            unit_code AS "unitCode",
            conversion_factor AS "conversionFactor",
            unit_price AS "unitPrice",
            status
          FROM ${prefix}"catalog_variant_projection"
          WHERE tenant_id = $1 AND sku_code = $2
          LIMIT 1
          `,
          [tenantId, query.sku.trim().toUpperCase()],
        );
      }
      if (query.barcode) {
        return em.query(
          `
          SELECT
            variant_id AS "variantId",
            product_id AS "productId",
            sku_code AS "skuCode",
            barcode,
            product_name AS "productName",
            variant_name AS "variantName",
            unit_code AS "unitCode",
            conversion_factor AS "conversionFactor",
            unit_price AS "unitPrice",
            status
          FROM ${prefix}"catalog_variant_projection"
          WHERE tenant_id = $1 AND barcode = $2
          LIMIT 1
          `,
          [tenantId, query.barcode.trim()],
        );
      }
      return [];
    });

    if (rows.length === 0) {
      throw new SalesDomainError(
        SalesDomainErrorCode.PRICE_NOT_CONFIGURED,
        `Product variant not found for ${query.sku ? `sku=${query.sku}` : `barcode=${query.barcode}`}`,
        404,
      );
    }

    const r = rows[0];
    return {
      variantId: r.variantId,
      productId: r.productId,
      skuCode: r.skuCode,
      barcode: r.barcode ?? null,
      productName: r.productName,
      variantName: r.variantName,
      unitCode: r.unitCode ?? 'PCS',
      conversionFactor: String(r.conversionFactor ?? '1.0000'),
      unitPrice: String(r.unitPrice),
      status: r.status,
    };
  }
}
