import { enableTenantRlsPolicy, qualifiedTable } from '@pbl/events';
import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateM3SalesCore1791900000200 implements MigrationInterface {
  name = 'CreateM3SalesCore1791900000200';

  async up(queryRunner: QueryRunner): Promise<void> {
    const t = (name: string) => qualifiedTable(queryRunner, name);

    const orders = t('orders');
    const orderItems = t('order_items');
    const branchProjection = t('branch_projection');
    const checkoutWorkflow = t('checkout_workflow');
    const codeSeq = t('sales_code_sequence');
    const catalogProjection = t('catalog_variant_projection');
    const statusHistory = t('order_status_history');
    const shifts = t('pos_shifts');
    const drafts = t('pos_drafts');
    const tenders = t('order_tenders');
    const returns = t('sales_returns');
    const returnItems = t('sales_return_items');
    const refundRequests = t('refund_requests');
    const fulfillments = t('order_fulfillments');
    const fulfillmentItems = t('fulfillment_items');
    const promotions = t('promotions');
    const coupons = t('coupons');
    const couponUsages = t('coupon_usages');

    // 1. Enable RLS on legacy M0 tables that missed RLS in 1791800000000
    await enableTenantRlsPolicy(queryRunner, orders);
    await enableTenantRlsPolicy(queryRunner, orderItems);
    await enableTenantRlsPolicy(queryRunner, branchProjection);

    // 2. Extend orders table with 3D statuses, financial breakdown, omnichannel refs, and optimistic version
    await queryRunner.query(`
      ALTER TABLE ${orders}
        ADD COLUMN IF NOT EXISTS "channel_type" character varying(24) NOT NULL DEFAULT 'POS',
        ADD COLUMN IF NOT EXISTS "channel_id" uuid NULL,
        ADD COLUMN IF NOT EXISTS "source_connection_id" character varying(64) NULL,
        ADD COLUMN IF NOT EXISTS "external_order_id" character varying(128) NULL,
        ADD COLUMN IF NOT EXISTS "warehouse_id" uuid NULL,
        ADD COLUMN IF NOT EXISTS "customer_id" uuid NULL,
        ADD COLUMN IF NOT EXISTS "shift_id" uuid NULL,
        ADD COLUMN IF NOT EXISTS "order_status" character varying(24) NOT NULL DEFAULT 'COMPLETED',
        ADD COLUMN IF NOT EXISTS "payment_status" character varying(24) NOT NULL DEFAULT 'PAID',
        ADD COLUMN IF NOT EXISTS "fulfillment_status" character varying(24) NOT NULL DEFAULT 'FULFILLED',
        ADD COLUMN IF NOT EXISTS "subtotal" numeric(18,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "item_discount_total" numeric(18,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "order_discount_type" character varying(16) NOT NULL DEFAULT 'NONE',
        ADD COLUMN IF NOT EXISTS "order_discount_value" numeric(18,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "order_discount_total" numeric(18,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "promotion_discount_total" numeric(18,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "coupon_code" character varying(64) NULL,
        ADD COLUMN IF NOT EXISTS "shipping_fee" numeric(18,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "tax_total" numeric(18,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "grand_total" numeric(18,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "paid_amount" numeric(18,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "refunded_amount" numeric(18,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "currency" character varying(8) NOT NULL DEFAULT 'VND',
        ADD COLUMN IF NOT EXISTS "reservation_id" uuid NULL,
        ADD COLUMN IF NOT EXISTS "note" text NULL,
        ADD COLUMN IF NOT EXISTS "cancel_reason" character varying(255) NULL,
        ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        ADD COLUMN IF NOT EXISTS "completed_at" TIMESTAMPTZ NULL,
        ADD COLUMN IF NOT EXISTS "cancelled_at" TIMESTAMPTZ NULL,
        ADD CONSTRAINT "UQ_orders_tenant_id" UNIQUE ("tenant_id", "id"),
        ADD CONSTRAINT "CHK_orders_order_status" CHECK (
          "order_status" IN ('DRAFT', 'PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED')
        ),
        ADD CONSTRAINT "CHK_orders_payment_status" CHECK (
          "payment_status" IN ('UNPAID', 'PARTIALLY_PAID', 'PAID', 'REFUND_PENDING', 'PARTIALLY_REFUNDED', 'REFUNDED')
        ),
        ADD CONSTRAINT "CHK_orders_fulfillment_status" CHECK (
          "fulfillment_status" IN ('UNFULFILLED', 'RESERVED', 'PARTIALLY_FULFILLED', 'FULFILLED', 'RETURNED')
        ),
        ADD CONSTRAINT "CHK_orders_amounts_non_negative" CHECK (
          "subtotal" >= 0 AND "item_discount_total" >= 0 AND "order_discount_total" >= 0
          AND "promotion_discount_total" >= 0 AND "shipping_fee" >= 0 AND "tax_total" >= 0
          AND "grand_total" >= 0 AND "paid_amount" >= 0 AND "refunded_amount" >= 0
        )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_orders_tenant_external"
      ON ${orders} ("tenant_id", "source_connection_id", "external_order_id")
      WHERE "source_connection_id" IS NOT NULL AND "external_order_id" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_orders_tenant_branch_created"
      ON ${orders} ("tenant_id", "branch_id", "created_at" DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_orders_tenant_status_created"
      ON ${orders} ("tenant_id", "order_status", "created_at" DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_orders_tenant_shift"
      ON ${orders} ("tenant_id", "shift_id")
      WHERE "shift_id" IS NOT NULL
    `);

    // 3. Extend order_items table with immutable commercial snapshots & return tracking
    await queryRunner.query(`
      ALTER TABLE ${orderItems}
        ADD COLUMN IF NOT EXISTS "variant_id" uuid NULL,
        ADD COLUMN IF NOT EXISTS "product_id" uuid NULL,
        ADD COLUMN IF NOT EXISTS "variant_label" character varying(150) NULL,
        ADD COLUMN IF NOT EXISTS "unit_code" character varying(32) NOT NULL DEFAULT 'PCS',
        ADD COLUMN IF NOT EXISTS "conversion_factor" numeric(18,4) NOT NULL DEFAULT 1.0000,
        ADD COLUMN IF NOT EXISTS "qty" numeric(18,3) NOT NULL DEFAULT 1.000,
        ADD COLUMN IF NOT EXISTS "base_qty" numeric(18,3) NOT NULL DEFAULT 1.000,
        ADD COLUMN IF NOT EXISTS "line_gross" numeric(18,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "item_discount_type" character varying(16) NOT NULL DEFAULT 'NONE',
        ADD COLUMN IF NOT EXISTS "item_discount_value" numeric(18,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "item_discount_amount" numeric(18,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "allocated_order_discount" numeric(18,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "line_net" numeric(18,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "tax_rate" numeric(6,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "tax_amount" numeric(18,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "unit_cost_snapshot" numeric(18,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "returned_qty" numeric(18,3) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "refunded_amount" numeric(18,2) NOT NULL DEFAULT 0,
        ADD CONSTRAINT "UQ_order_items_tenant_id" UNIQUE ("tenant_id", "id"),
        ADD CONSTRAINT "CHK_order_items_returned_non_negative" CHECK ("returned_qty" >= 0 AND "refunded_amount" >= 0)
    `);

    // 4. Extend checkout_workflow table with full M3 saga states & metadata
    await queryRunner.query(`
      ALTER TABLE ${checkoutWorkflow}
        DROP CONSTRAINT IF EXISTS "CHK_checkout_workflow_state"
    `);
    await queryRunner.query(`
      ALTER TABLE ${checkoutWorkflow}
        ADD COLUMN IF NOT EXISTS "shift_id" uuid NULL,
        ADD COLUMN IF NOT EXISTS "draft_id" uuid NULL,
        ADD COLUMN IF NOT EXISTS "customer_id" uuid NULL,
        ADD COLUMN IF NOT EXISTS "coupon_code" character varying(64) NULL,
        ADD COLUMN IF NOT EXISTS "quote_json" jsonb NULL,
        ADD COLUMN IF NOT EXISTS "tenders_json" jsonb NULL,
        ADD COLUMN IF NOT EXISTS "commit_confirmed" boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "retry_count" integer NOT NULL DEFAULT 0,
        ADD CONSTRAINT "CHK_checkout_workflow_state" CHECK (
          "state" IN (
            'PENDING_STOCK',
            'RESERVING',
            'RESERVING_STOCK',
            'STOCK_RESERVED',
            'AWAITING_PAYMENT',
            'COMMITTING_STOCK',
            'FINALIZING',
            'CONFIRMED',
            'COMPLETED',
            'RECOVERY_PENDING',
            'REQUIRES_RECONCILIATION',
            'REJECTED',
            'CANCELLED'
          )
        )
    `);

    // 5. Tenant-scoped atomic sequence table for Order/Return/Shift/Fulfillment codes
    await queryRunner.query(`
      CREATE TABLE ${codeSeq} (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "seq_key" character varying(64) NOT NULL,
        "last_value" bigint NOT NULL DEFAULT 0,
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_sales_code_sequence_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_sales_code_sequence_tenant_key" UNIQUE ("tenant_id", "seq_key")
      )
    `);
    await enableTenantRlsPolicy(queryRunner, codeSeq);

    // 6. Catalog Variant & Price Projection table in Sales
    await queryRunner.query(`
      CREATE TABLE ${catalogProjection} (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "variant_id" uuid NOT NULL,
        "product_id" uuid NOT NULL,
        "sku_code" character varying(64) NOT NULL,
        "barcode" character varying(64) NULL,
        "product_name" character varying(255) NOT NULL,
        "variant_name" character varying(255) NOT NULL,
        "unit_code" character varying(32) NOT NULL DEFAULT 'PCS',
        "conversion_factor" numeric(18,4) NOT NULL DEFAULT 1.0000,
        "unit_price" numeric(18,2) NOT NULL DEFAULT 0,
        "status" character varying(20) NOT NULL DEFAULT 'ACTIVE',
        "aggregate_version" integer NOT NULL DEFAULT 1,
        "source_updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "synced_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_catalog_variant_projection_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_catalog_variant_projection_tenant_variant" UNIQUE ("tenant_id", "variant_id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_catalog_variant_projection_sku"
      ON ${catalogProjection} ("tenant_id", "sku_code")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_catalog_variant_projection_barcode"
      ON ${catalogProjection} ("tenant_id", "barcode")
      WHERE "barcode" IS NOT NULL
    `);
    await enableTenantRlsPolicy(queryRunner, catalogProjection);

    // 7. Order Status History table
    await queryRunner.query(`
      CREATE TABLE ${statusHistory} (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "order_id" uuid NOT NULL,
        "from_order_status" character varying(24) NULL,
        "to_order_status" character varying(24) NOT NULL,
        "from_payment_status" character varying(24) NULL,
        "to_payment_status" character varying(24) NOT NULL,
        "from_fulfillment_status" character varying(24) NULL,
        "to_fulfillment_status" character varying(24) NOT NULL,
        "reason" character varying(255) NULL,
        "actor_id" character varying(64) NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_order_status_history_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_order_status_history_order"
          FOREIGN KEY ("tenant_id", "order_id") REFERENCES ${orders}("tenant_id", "id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_order_status_history_order"
      ON ${statusHistory} ("tenant_id", "order_id", "created_at" ASC)
    `);
    await enableTenantRlsPolicy(queryRunner, statusHistory);

    // 8. POS Shifts table
    await queryRunner.query(`
      CREATE TABLE ${shifts} (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "code" character varying(32) NOT NULL,
        "branch_id" uuid NOT NULL,
        "register_code" character varying(32) NOT NULL DEFAULT 'REG-01',
        "staff_id" uuid NOT NULL,
        "status" character varying(16) NOT NULL DEFAULT 'OPEN',
        "opening_cash" numeric(18,2) NOT NULL DEFAULT 0,
        "cash_sales_total" numeric(18,2) NOT NULL DEFAULT 0,
        "cash_refunds_total" numeric(18,2) NOT NULL DEFAULT 0,
        "expected_cash" numeric(18,2) NOT NULL DEFAULT 0,
        "actual_cash" numeric(18,2) NULL,
        "variance" numeric(18,2) NULL,
        "open_note" text NULL,
        "close_note" text NULL,
        "closed_by" uuid NULL,
        "opened_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "closed_at" TIMESTAMPTZ NULL,
        "version" integer NOT NULL DEFAULT 1,
        CONSTRAINT "PK_pos_shifts_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_pos_shifts_tenant_id" UNIQUE ("tenant_id", "id"),
        CONSTRAINT "UQ_pos_shifts_tenant_code" UNIQUE ("tenant_id", "code"),
        CONSTRAINT "CHK_pos_shifts_status" CHECK ("status" IN ('OPEN', 'CLOSED')),
        CONSTRAINT "CHK_pos_shifts_non_negative" CHECK (
          "opening_cash" >= 0 AND "cash_sales_total" >= 0 AND "cash_refunds_total" >= 0
        )
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_pos_shifts_active_staff_register"
      ON ${shifts} ("tenant_id", "branch_id", "staff_id", "register_code")
      WHERE "status" = 'OPEN'
    `);
    await enableTenantRlsPolicy(queryRunner, shifts);

    // 9. POS Draft Invoices table
    await queryRunner.query(`
      CREATE TABLE ${drafts} (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "branch_id" uuid NOT NULL,
        "warehouse_id" uuid NULL,
        "shift_id" uuid NULL,
        "staff_id" uuid NOT NULL,
        "customer_id" uuid NULL,
        "customer_name" character varying(150) NULL,
        "title" character varying(120) NULL,
        "lines_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "order_discount_type" character varying(16) NOT NULL DEFAULT 'NONE',
        "order_discount_value" numeric(18,2) NOT NULL DEFAULT 0,
        "coupon_code" character varying(64) NULL,
        "payment_method" character varying(32) NOT NULL DEFAULT 'CASH',
        "note" text NULL,
        "status" character varying(16) NOT NULL DEFAULT 'ACTIVE',
        "expires_at" TIMESTAMPTZ NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_pos_drafts_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_pos_drafts_tenant_id" UNIQUE ("tenant_id", "id"),
        CONSTRAINT "CHK_pos_drafts_status" CHECK ("status" IN ('ACTIVE', 'CONVERTED', 'EXPIRED'))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_pos_drafts_active_staff"
      ON ${drafts} ("tenant_id", "branch_id", "staff_id", "status")
    `);
    await enableTenantRlsPolicy(queryRunner, drafts);

    // 10. Order Tenders table (Payment allocations & evidence)
    await queryRunner.query(`
      CREATE TABLE ${tenders} (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "order_id" uuid NOT NULL,
        "checkout_id" uuid NULL,
        "shift_id" uuid NULL,
        "idempotency_key" character varying(128) NOT NULL,
        "method" character varying(24) NOT NULL,
        "amount" numeric(18,2) NOT NULL,
        "tendered_cash" numeric(18,2) NOT NULL DEFAULT 0,
        "change_due" numeric(18,2) NOT NULL DEFAULT 0,
        "status" character varying(16) NOT NULL DEFAULT 'CONFIRMED',
        "external_ref" character varying(128) NULL,
        "confirmed_by" character varying(64) NULL,
        "confirmed_at" TIMESTAMPTZ NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_order_tenders_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_order_tenders_idempotency" UNIQUE ("tenant_id", "idempotency_key"),
        CONSTRAINT "FK_order_tenders_order"
          FOREIGN KEY ("tenant_id", "order_id") REFERENCES ${orders}("tenant_id", "id") ON DELETE CASCADE,
        CONSTRAINT "CHK_order_tenders_method" CHECK (
          "method" IN ('CASH', 'BANK_TRANSFER', 'CARD', 'E_WALLET', 'COD', 'ON_ACCOUNT')
        ),
        CONSTRAINT "CHK_order_tenders_status" CHECK (
          "status" IN ('PENDING', 'CONFIRMED', 'FAILED')
        ),
        CONSTRAINT "CHK_order_tenders_amounts" CHECK (
          "amount" >= 0 AND "tendered_cash" >= 0 AND "change_due" >= 0
        )
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_order_tenders_order"
      ON ${tenders} ("tenant_id", "order_id")
    `);
    await enableTenantRlsPolicy(queryRunner, tenders);

    // 11. Sales Returns, Return Items & Refund Requests tables
    await queryRunner.query(`
      CREATE TABLE ${returns} (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "code" character varying(32) NOT NULL,
        "order_id" uuid NOT NULL,
        "branch_id" uuid NOT NULL,
        "warehouse_id" uuid NULL,
        "shift_id" uuid NULL,
        "status" character varying(24) NOT NULL DEFAULT 'REQUESTED',
        "total_refund_amount" numeric(18,2) NOT NULL DEFAULT 0,
        "inventory_receipt_id" uuid NULL,
        "note" text NULL,
        "requested_by" character varying(64) NOT NULL,
        "approved_by" character varying(64) NULL,
        "received_by" character varying(64) NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_sales_returns_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_sales_returns_tenant_id" UNIQUE ("tenant_id", "id"),
        CONSTRAINT "UQ_sales_returns_tenant_code" UNIQUE ("tenant_id", "code"),
        CONSTRAINT "FK_sales_returns_order"
          FOREIGN KEY ("tenant_id", "order_id") REFERENCES ${orders}("tenant_id", "id") ON DELETE RESTRICT,
        CONSTRAINT "CHK_sales_returns_status" CHECK (
          "status" IN ('REQUESTED', 'APPROVED', 'REJECTED', 'RECEIVED', 'REFUND_REQUESTED', 'COMPLETED')
        ),
        CONSTRAINT "CHK_sales_returns_amount" CHECK ("total_refund_amount" >= 0)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_sales_returns_order"
      ON ${returns} ("tenant_id", "order_id", "created_at" DESC)
    `);
    await enableTenantRlsPolicy(queryRunner, returns);

    await queryRunner.query(`
      CREATE TABLE ${returnItems} (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "return_id" uuid NOT NULL,
        "order_item_id" uuid NOT NULL,
        "variant_id" uuid NULL,
        "sku_code" character varying(64) NOT NULL,
        "product_name" character varying(200) NOT NULL,
        "return_qty" numeric(18,3) NOT NULL,
        "unit_refund_amount" numeric(18,2) NOT NULL,
        "refund_amount" numeric(18,2) NOT NULL,
        "disposition" character varying(24) NOT NULL DEFAULT 'RESTOCK',
        "reason" character varying(255) NULL,
        CONSTRAINT "PK_sales_return_items_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_sales_return_items_return"
          FOREIGN KEY ("tenant_id", "return_id") REFERENCES ${returns}("tenant_id", "id") ON DELETE CASCADE,
        CONSTRAINT "CHK_sales_return_items_qty" CHECK ("return_qty" > 0 AND "refund_amount" >= 0),
        CONSTRAINT "CHK_sales_return_items_disposition" CHECK (
          "disposition" IN ('RESTOCK', 'DAMAGED', 'QUARANTINE', 'NO_PHYSICAL_RETURN')
        )
      )
    `);
    await enableTenantRlsPolicy(queryRunner, returnItems);

    await queryRunner.query(`
      CREATE TABLE ${refundRequests} (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "return_id" uuid NOT NULL,
        "order_id" uuid NOT NULL,
        "branch_id" uuid NOT NULL,
        "shift_id" uuid NULL,
        "idempotency_key" character varying(128) NOT NULL,
        "amount" numeric(18,2) NOT NULL,
        "method" character varying(24) NOT NULL DEFAULT 'CASH',
        "status" character varying(24) NOT NULL DEFAULT 'PENDING',
        "external_settlement_ref" character varying(128) NULL,
        "requested_by" character varying(64) NOT NULL,
        "confirmed_at" TIMESTAMPTZ NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_refund_requests_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_refund_requests_idempotency" UNIQUE ("tenant_id", "idempotency_key"),
        CONSTRAINT "UQ_refund_requests_return" UNIQUE ("tenant_id", "return_id"),
        CONSTRAINT "FK_refund_requests_return"
          FOREIGN KEY ("tenant_id", "return_id") REFERENCES ${returns}("tenant_id", "id") ON DELETE RESTRICT,
        CONSTRAINT "CHK_refund_requests_status" CHECK (
          "status" IN ('PENDING', 'CONFIRMED', 'REJECTED')
        ),
        CONSTRAINT "CHK_refund_requests_amount" CHECK ("amount" >= 0)
      )
    `);
    await enableTenantRlsPolicy(queryRunner, refundRequests);

    // 12. Order Fulfillments & Fulfillment Items tables
    await queryRunner.query(`
      CREATE TABLE ${fulfillments} (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "code" character varying(32) NOT NULL,
        "order_id" uuid NOT NULL,
        "branch_id" uuid NOT NULL,
        "warehouse_id" uuid NULL,
        "reservation_id" uuid NULL,
        "fulfillment_type" character varying(24) NOT NULL DEFAULT 'POS_PICKUP',
        "status" character varying(24) NOT NULL DEFAULT 'PENDING',
        "carrier_code" character varying(64) NULL,
        "tracking_number" character varying(128) NULL,
        "shipped_at" TIMESTAMPTZ NULL,
        "confirmed_at" TIMESTAMPTZ NULL,
        "created_by" character varying(64) NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_order_fulfillments_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_order_fulfillments_tenant_id" UNIQUE ("tenant_id", "id"),
        CONSTRAINT "UQ_order_fulfillments_tenant_code" UNIQUE ("tenant_id", "code"),
        CONSTRAINT "FK_order_fulfillments_order"
          FOREIGN KEY ("tenant_id", "order_id") REFERENCES ${orders}("tenant_id", "id") ON DELETE CASCADE,
        CONSTRAINT "CHK_order_fulfillments_status" CHECK (
          "status" IN ('PENDING', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'COMPLETED', 'CANCELLED')
        )
      )
    `);
    await enableTenantRlsPolicy(queryRunner, fulfillments);

    await queryRunner.query(`
      CREATE TABLE ${fulfillmentItems} (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "fulfillment_id" uuid NOT NULL,
        "order_item_id" uuid NOT NULL,
        "sku_code" character varying(64) NOT NULL,
        "qty" numeric(18,3) NOT NULL,
        CONSTRAINT "PK_fulfillment_items_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_fulfillment_items_fulfillment"
          FOREIGN KEY ("tenant_id", "fulfillment_id") REFERENCES ${fulfillments}("tenant_id", "id") ON DELETE CASCADE,
        CONSTRAINT "CHK_fulfillment_items_qty" CHECK ("qty" > 0)
      )
    `);
    await enableTenantRlsPolicy(queryRunner, fulfillmentItems);

    // 13. Promotions, Coupons & Coupon Usages tables
    await queryRunner.query(`
      CREATE TABLE ${promotions} (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "code" character varying(48) NOT NULL,
        "name" character varying(160) NOT NULL,
        "discount_type" character varying(16) NOT NULL,
        "discount_value" numeric(18,2) NOT NULL,
        "min_order_amount" numeric(18,2) NOT NULL DEFAULT 0,
        "max_discount_amount" numeric(18,2) NULL,
        "branch_id" uuid NULL,
        "starts_at" TIMESTAMPTZ NULL,
        "ends_at" TIMESTAMPTZ NULL,
        "status" character varying(16) NOT NULL DEFAULT 'ACTIVE',
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_promotions_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_promotions_tenant_id" UNIQUE ("tenant_id", "id"),
        CONSTRAINT "UQ_promotions_tenant_code" UNIQUE ("tenant_id", "code"),
        CONSTRAINT "CHK_promotions_type" CHECK ("discount_type" IN ('FIXED', 'PERCENT'))
      )
    `);
    await enableTenantRlsPolicy(queryRunner, promotions);

    await queryRunner.query(`
      CREATE TABLE ${coupons} (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "promotion_id" uuid NOT NULL,
        "code" character varying(48) NOT NULL,
        "max_uses" integer NULL,
        "max_uses_per_customer" integer NULL,
        "used_count" integer NOT NULL DEFAULT 0,
        "status" character varying(16) NOT NULL DEFAULT 'ACTIVE',
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_coupons_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_coupons_tenant_id" UNIQUE ("tenant_id", "id"),
        CONSTRAINT "UQ_coupons_tenant_code" UNIQUE ("tenant_id", "code"),
        CONSTRAINT "FK_coupons_promotion"
          FOREIGN KEY ("tenant_id", "promotion_id") REFERENCES ${promotions}("tenant_id", "id") ON DELETE CASCADE,
        CONSTRAINT "CHK_coupons_usage" CHECK (
          "used_count" >= 0 AND ("max_uses" IS NULL OR "used_count" <= "max_uses")
        )
      )
    `);
    await enableTenantRlsPolicy(queryRunner, coupons);

    await queryRunner.query(`
      CREATE TABLE ${couponUsages} (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "coupon_id" uuid NOT NULL,
        "order_id" uuid NOT NULL,
        "customer_id" uuid NULL,
        "discount_amount" numeric(18,2) NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_coupon_usages_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_coupon_usages_order" UNIQUE ("tenant_id", "coupon_id", "order_id"),
        CONSTRAINT "FK_coupon_usages_coupon"
          FOREIGN KEY ("tenant_id", "coupon_id") REFERENCES ${coupons}("tenant_id", "id") ON DELETE RESTRICT
      )
    `);
    await enableTenantRlsPolicy(queryRunner, couponUsages);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const t = (name: string) => qualifiedTable(queryRunner, name);
    for (const name of [
      'coupon_usages',
      'coupons',
      'promotions',
      'fulfillment_items',
      'order_fulfillments',
      'refund_requests',
      'sales_return_items',
      'sales_returns',
      'order_tenders',
      'pos_drafts',
      'pos_shifts',
      'order_status_history',
      'catalog_variant_projection',
      'sales_code_sequence',
    ]) {
      await queryRunner.query(`DROP TABLE IF EXISTS ${t(name)} CASCADE`);
    }
  }
}
