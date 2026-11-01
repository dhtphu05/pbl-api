import { Injectable } from '@nestjs/common';
import { EventEnvelope } from '@pbl/common';
import {
  CATALOG_PRODUCT_DEACTIVATED,
  CATALOG_VARIANT_CREATED,
  CATALOG_VARIANT_DEACTIVATED,
  CATALOG_VARIANT_UPDATED,
  CatalogProductEventPayload,
  CatalogVariantEventPayload,
  INVENTORY_STOCK_CHANGED,
  StockChangedPayload,
} from '@pbl/contracts';
import { OnEvent } from '@pbl/events';
import { randomUUID } from 'node:crypto';
import { EntityManager } from 'typeorm';
import {
  IntegrationCatalogVariantEntity,
  IntegrationStockProjectionEntity,
  SkuMappingEntity,
} from '../infrastructure/persistence/integration.entities';
import { InventorySyncService } from '../modules/inventory-sync/inventory-sync.service';

@Injectable()
export class IntegrationEventsConsumer {
  constructor(private readonly inventorySyncService: InventorySyncService) {}

  @OnEvent(CATALOG_VARIANT_CREATED.type)
  async onCatalogVariantCreated(
    event: EventEnvelope<CatalogVariantEventPayload>,
    em: EntityManager,
  ): Promise<void> {
    await this.upsertCatalogVariant(event, em);
  }

  @OnEvent(CATALOG_VARIANT_UPDATED.type)
  async onCatalogVariantUpdated(
    event: EventEnvelope<CatalogVariantEventPayload>,
    em: EntityManager,
  ): Promise<void> {
    await this.upsertCatalogVariant(event, em);
  }

  @OnEvent(CATALOG_VARIANT_DEACTIVATED.type)
  async onCatalogVariantDeactivated(
    event: EventEnvelope<CatalogVariantEventPayload>,
    em: EntityManager,
  ): Promise<void> {
    await this.upsertCatalogVariant(event, em);
  }

  @OnEvent(CATALOG_PRODUCT_DEACTIVATED.type)
  async onCatalogProductDeactivated(
    event: EventEnvelope<CatalogProductEventPayload>,
    em: EntityManager,
  ): Promise<void> {
    await em.query(`SELECT set_config('app.tenant_id', $1, true)`, [
      event.tenantId,
    ]);
    await em.update(
      IntegrationCatalogVariantEntity,
      { tenantId: event.tenantId, productId: event.payload.productId },
      { status: 'INACTIVE', syncedAt: new Date() },
    );
    await em.update(
      SkuMappingEntity,
      { tenantId: event.tenantId, internalProductId: event.payload.productId },
      { status: 'NEEDS_REVIEW', listingSyncStatus: 'NEEDS_REVIEW' },
    );
  }

  @OnEvent(INVENTORY_STOCK_CHANGED.type)
  async onInventoryStockChanged(
    event: EventEnvelope<StockChangedPayload>,
    em: EntityManager,
  ): Promise<void> {
    await em.query(`SELECT set_config('app.tenant_id', $1, true)`, [
      event.tenantId,
    ]);
    const catalogVariant = await em
      .getRepository(IntegrationCatalogVariantEntity)
      .findOne({
        where: [
          { tenantId: event.tenantId, variantId: event.payload.skuId },
          { tenantId: event.tenantId, skuCode: event.payload.skuId },
        ],
      });
    const resolvedVariantId = catalogVariant?.variantId ?? event.payload.skuId;

    const existing = await em
      .getRepository(IntegrationStockProjectionEntity)
      .findOne({
        where: {
          tenantId: event.tenantId,
          warehouseId: event.payload.warehouseId,
          skuId: resolvedVariantId,
        },
      });
    const nextVersion = existing ? Number(existing.stockVersion) + 1 : 1;

    await this.inventorySyncService.recordStockChangeAndPublish({
      tenantId: event.tenantId,
      internalVariantId: resolvedVariantId,
      warehouseId: event.payload.warehouseId,
      onHandQty: Number(event.payload.onHandAfter),
      reservedQty: Number(event.payload.reservedAfter),
      stockVersion: nextVersion,
    });
  }

  private async upsertCatalogVariant(
    event: EventEnvelope<CatalogVariantEventPayload>,
    em: EntityManager,
  ): Promise<void> {
    await em.query(`SELECT set_config('app.tenant_id', $1, true)`, [
      event.tenantId,
    ]);
    const p = event.payload;
    const existing = await em
      .getRepository(IntegrationCatalogVariantEntity)
      .findOne({
        where: { tenantId: event.tenantId, variantId: p.variantId },
        lock: { mode: 'pessimistic_write' },
      });

    if (existing && p.aggregateVersion < existing.aggregateVersion) {
      return;
    }

    const resolvedUpdatedAt = p.updatedAt
      ? new Date(p.updatedAt)
      : new Date(event.occurredAt);
    const resolvedBasePrice = Number(p.basePrice ?? 0).toFixed(2);

    if (!existing) {
      const created = em.create(IntegrationCatalogVariantEntity, {
        id: randomUUID(),
        tenantId: event.tenantId,
        variantId: p.variantId,
        productId: p.productId,
        skuCode: p.skuCode,
        barcode: p.barcode ?? null,
        name: p.name,
        basePrice: resolvedBasePrice,
        status: p.status,
        aggregateVersion: p.aggregateVersion,
        sourceUpdatedAt: resolvedUpdatedAt,
        syncedAt: new Date(),
      });
      await em.save(IntegrationCatalogVariantEntity, created);
    } else {
      existing.skuCode = p.skuCode;
      existing.barcode = p.barcode ?? null;
      existing.name = p.name;
      existing.basePrice = resolvedBasePrice;
      existing.status = p.status;
      existing.aggregateVersion = p.aggregateVersion;
      existing.sourceUpdatedAt = resolvedUpdatedAt;
      existing.syncedAt = new Date();
      await em.save(IntegrationCatalogVariantEntity, existing);
    }

    if (p.status !== 'ACTIVE') {
      await em.update(
        SkuMappingEntity,
        { tenantId: event.tenantId, internalVariantId: p.variantId },
        { status: 'NEEDS_REVIEW', listingSyncStatus: 'NEEDS_REVIEW' },
      );
    }
  }
}
