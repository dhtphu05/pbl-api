/**
 * Pure TypeScript Domain Layer for SapoClone M3 Sales & POS Microservice.
 * Zero NestJS or TypeORM imports — enforces decimal-safe retail pricing,
 * pro-rated discount waterfall, RBAC discount ceilings, 3D order state machines,
 * tender validation, shift cash reconciliation, and pro-rated return refunds.
 */

export const SalesDomainErrorCode = {
  ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
  ORDER_INVALID_STATE: 'ORDER_INVALID_STATE',
  ORDER_ALREADY_COMPLETED: 'ORDER_ALREADY_COMPLETED',
  ORDER_ALREADY_CANCELLED: 'ORDER_ALREADY_CANCELLED',

  PRODUCT_NOT_SELLABLE: 'PRODUCT_NOT_SELLABLE',
  PRICE_CHANGED: 'PRICE_CHANGED',
  PRICE_NOT_CONFIGURED: 'PRICE_NOT_CONFIGURED',
  INVALID_DISCOUNT: 'INVALID_DISCOUNT',
  DISCOUNT_APPROVAL_REQUIRED: 'DISCOUNT_APPROVAL_REQUIRED',

  INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',
  STOCK_RESERVATION_FAILED: 'STOCK_RESERVATION_FAILED',
  STOCK_RESERVATION_UNKNOWN: 'STOCK_RESERVATION_UNKNOWN',
  STOCK_COMMIT_PENDING: 'STOCK_COMMIT_PENDING',

  PAYMENT_NOT_CONFIRMED: 'PAYMENT_NOT_CONFIRMED',
  PAYMENT_AMOUNT_MISMATCH: 'PAYMENT_AMOUNT_MISMATCH',
  PAYMENT_OUTCOME_UNKNOWN: 'PAYMENT_OUTCOME_UNKNOWN',

  SHIFT_NOT_FOUND: 'SHIFT_NOT_FOUND',
  SHIFT_NOT_OPEN: 'SHIFT_NOT_OPEN',
  SHIFT_ALREADY_OPEN: 'SHIFT_ALREADY_OPEN',
  SHIFT_ALREADY_CLOSED: 'SHIFT_ALREADY_CLOSED',
  SHIFT_HAS_PENDING_TRANSACTIONS: 'SHIFT_HAS_PENDING_TRANSACTIONS',

  POS_DRAFT_NOT_FOUND: 'POS_DRAFT_NOT_FOUND',
  POS_DRAFT_LIMIT_EXCEEDED: 'POS_DRAFT_LIMIT_EXCEEDED',

  RETURN_NOT_FOUND: 'RETURN_NOT_FOUND',
  RETURN_NOT_ELIGIBLE: 'RETURN_NOT_ELIGIBLE',
  RETURN_QUANTITY_EXCEEDED: 'RETURN_QUANTITY_EXCEEDED',
  REFUND_AMOUNT_EXCEEDED: 'REFUND_AMOUNT_EXCEEDED',

  COUPON_INVALID: 'COUPON_INVALID',
  COUPON_USAGE_LIMIT_EXCEEDED: 'COUPON_USAGE_LIMIT_EXCEEDED',

  LOYALTY_HOLD_FAILED: 'LOYALTY_HOLD_FAILED',
  CREDIT_AUTHORIZATION_FAILED: 'CREDIT_AUTHORIZATION_FAILED',
  CREDIT_SERVICE_UNAVAILABLE: 'CREDIT_SERVICE_UNAVAILABLE',

  FULFILLMENT_NOT_FOUND: 'FULFILLMENT_NOT_FOUND',
  FULFILLMENT_INVALID_STATE: 'FULFILLMENT_INVALID_STATE',

  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  RESOURCE_VERSION_CONFLICT: 'RESOURCE_VERSION_CONFLICT',
  TENANT_ACCESS_DENIED: 'TENANT_ACCESS_DENIED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  UNKNOWN_BRANCH: 'UNKNOWN_BRANCH',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
} as const;

export type SalesDomainErrorCodeType =
  (typeof SalesDomainErrorCode)[keyof typeof SalesDomainErrorCode];

export class SalesDomainError extends Error {
  constructor(
    public readonly code: SalesDomainErrorCodeType,
    message: string,
    public readonly httpStatus = 409,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'SalesDomainError';
  }
}

// ---- Order 3D Status Types ----

export type CommercialOrderStatus =
  | 'DRAFT'
  | 'PENDING'
  | 'CONFIRMED'
  | 'CANCELLED'
  | 'COMPLETED';

export type OrderPaymentStatus =
  | 'UNPAID'
  | 'PARTIALLY_PAID'
  | 'PAID'
  | 'REFUND_PENDING'
  | 'PARTIALLY_REFUNDED'
  | 'REFUNDED';

export type OrderFulfillmentStatus =
  | 'UNFULFILLED'
  | 'RESERVED'
  | 'PARTIALLY_FULFILLED'
  | 'FULFILLED'
  | 'RETURNED';

export type SalesChannelType = 'POS' | 'MANUAL' | 'ONLINE' | 'MARKETPLACE';

export type DiscountType = 'NONE' | 'FIXED' | 'PERCENT';

export type TenderMethod =
  | 'CASH'
  | 'BANK_TRANSFER'
  | 'CARD'
  | 'E_WALLET'
  | 'COD'
  | 'ON_ACCOUNT'
  | 'COMBINED';

export type ReturnDisposition =
  | 'RESTOCK'
  | 'DAMAGED'
  | 'QUARANTINE'
  | 'NO_PHYSICAL_RETURN';

// ---- Decimal-Safe Arithmetic Helpers ----
// Quantities: NUMERIC(18,3) -> scaled by 1,000 (milli-units)
// Money (VND): Integer VND (or NUMERIC(18,2) rounded to integer VND for commercial totals)

const QTY_SCALE = 1000n;
const FACTOR_SCALE = 10000n;

export function parseQtyMillis(value: string | number): bigint {
  const raw = String(value).trim();
  if (!/^\d+(\.\d{1,3})?$/.test(raw)) {
    throw new SalesDomainError(
      SalesDomainErrorCode.VALIDATION_ERROR,
      `Invalid quantity format: ${raw}`,
      422,
    );
  }
  const [intPart, fracPart = ''] = raw.split('.');
  const padded = (fracPart + '000').slice(0, 3);
  const res = BigInt(intPart) * QTY_SCALE + BigInt(padded);
  if (res <= 0n) {
    throw new SalesDomainError(
      SalesDomainErrorCode.VALIDATION_ERROR,
      `Quantity must be strictly positive: ${raw}`,
      422,
    );
  }
  return res;
}

export function formatQtyMillis(millis: bigint): string {
  const sign = millis < 0n ? '-' : '';
  const abs = millis < 0n ? -millis : millis;
  const intPart = abs / QTY_SCALE;
  const fracPart = (abs % QTY_SCALE).toString().padStart(3, '0');
  return `${sign}${intPart.toString()}.${fracPart}`;
}

export function parseConversionFactor(value?: string | number | null): bigint {
  if (value === undefined || value === null || value === '') {
    return FACTOR_SCALE;
  }
  const raw = String(value).trim();
  if (!/^\d+(\.\d{1,4})?$/.test(raw)) {
    throw new SalesDomainError(
      SalesDomainErrorCode.VALIDATION_ERROR,
      `Invalid conversion factor: ${raw}`,
      422,
    );
  }
  const [intPart, fracPart = ''] = raw.split('.');
  const padded = (fracPart + '0000').slice(0, 4);
  const res = BigInt(intPart) * FACTOR_SCALE + BigInt(padded);
  if (res <= 0n) {
    throw new SalesDomainError(
      SalesDomainErrorCode.VALIDATION_ERROR,
      `Conversion factor must be > 0: ${raw}`,
      422,
    );
  }
  return res;
}

export function computeBaseQtyMillis(
  qtyMillis: bigint,
  factorTenThousands: bigint,
): bigint {
  const num = qtyMillis * factorTenThousands + FACTOR_SCALE / 2n;
  return num / FACTOR_SCALE;
}

export function parseVndAmount(
  value: string | number | bigint | undefined | null,
  allowZero = true,
): bigint {
  if (value === undefined || value === null || value === '') {
    if (allowZero) return 0n;
    throw new SalesDomainError(
      SalesDomainErrorCode.VALIDATION_ERROR,
      'Monetary amount is required',
      422,
    );
  }
  if (typeof value === 'bigint') {
    if (value < 0n || (!allowZero && value === 0n)) {
      throw new SalesDomainError(
        SalesDomainErrorCode.VALIDATION_ERROR,
        `Invalid monetary amount: ${value.toString()}`,
        422,
      );
    }
    return value;
  }
  const raw = String(value).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
    throw new SalesDomainError(
      SalesDomainErrorCode.VALIDATION_ERROR,
      `Invalid VND monetary amount: ${raw}`,
      422,
    );
  }
  const [intPart, fracPart = ''] = raw.split('.');
  const cents = BigInt((fracPart + '00').slice(0, 2));
  // Round half up to integer VND
  const vnd = BigInt(intPart) + (cents >= 50n ? 1n : 0n);
  if (vnd < 0n || (!allowZero && vnd === 0n)) {
    throw new SalesDomainError(
      SalesDomainErrorCode.VALIDATION_ERROR,
      `Monetary amount must be ${allowZero ? 'non-negative' : 'positive'}: ${raw}`,
      422,
    );
  }
  return vnd;
}

export function formatVnd(amount: bigint): string {
  return `${amount.toString()}.00`;
}

export function roundDivHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new Error('Denominator must be positive');
  }
  if (numerator >= 0n) {
    return (numerator + denominator / 2n) / denominator;
  }
  return -((-numerator + denominator / 2n) / denominator);
}

// ---- Pricing & Discount Waterfall ----

export interface AuthoritativeCatalogVariant {
  variantId: string;
  productId: string;
  skuCode: string;
  barcode: string | null;
  productName: string;
  variantName: string;
  unitCode: string;
  conversionFactor: string;
  unitPrice: string;
  status: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED' | 'DRAFT';
  unitCostSnapshot?: string;
}

export interface QuoteLineInput {
  variantId: string;
  qty: string | number;
  expectedUnitPrice?: string | number;
  discountType?: DiscountType;
  discountValue?: string | number;
  taxRatePercent?: string | number;
}

export interface QuoteOrderInput {
  lines: QuoteLineInput[];
  orderDiscountType?: DiscountType;
  orderDiscountValue?: string | number;
  promotionDiscountAmount?: string | number;
  shippingFee?: string | number;
}

export interface CalculatedOrderLine {
  lineNo: number;
  variantId: string;
  productId: string;
  skuCode: string;
  productName: string;
  variantLabel: string;
  unitCode: string;
  conversionFactor: string;
  qty: string;
  baseQty: string;
  unitPrice: string;
  lineGross: string;
  itemDiscountType: DiscountType;
  itemDiscountValue: string;
  itemDiscountAmount: string;
  lineAfterItemDiscount: string;
  allocatedOrderDiscount: string;
  lineNet: string;
  taxRate: string;
  taxAmount: string;
  lineTotal: string;
  unitCostSnapshot: string;
}

export interface CalculatedOrderQuote {
  lines: CalculatedOrderLine[];
  subtotal: string;
  itemDiscountTotal: string;
  orderDiscountType: DiscountType;
  orderDiscountValue: string;
  orderDiscountTotal: string;
  promotionDiscountTotal: string;
  totalDiscount: string;
  effectiveDiscountPercent: number;
  shippingFee: string;
  taxTotal: string;
  grandTotal: string;
  totalBaseQty: string;
}

export function calculateItemDiscount(
  lineGross: bigint,
  discountType: DiscountType = 'NONE',
  discountValue?: string | number,
): bigint {
  if (
    discountType === 'NONE' ||
    discountValue === undefined ||
    discountValue === null
  ) {
    return 0n;
  }
  if (discountType === 'FIXED') {
    const fixed = parseVndAmount(discountValue, true);
    if (fixed > lineGross) {
      throw new SalesDomainError(
        SalesDomainErrorCode.INVALID_DISCOUNT,
        `Item fixed discount (${fixed}) cannot exceed line gross (${lineGross})`,
        422,
      );
    }
    return fixed;
  }
  if (discountType === 'PERCENT') {
    const num = Number(discountValue);
    if (!Number.isFinite(num) || num < 0 || num > 100) {
      throw new SalesDomainError(
        SalesDomainErrorCode.INVALID_DISCOUNT,
        `Item percentage discount must be between 0 and 100, got ${discountValue}`,
        422,
      );
    }
    const basisPoints = BigInt(Math.round(num * 100));
    return roundDivHalfUp(lineGross * basisPoints, 10000n);
  }
  throw new SalesDomainError(
    SalesDomainErrorCode.INVALID_DISCOUNT,
    `Unsupported discount type: ${discountType}`,
    422,
  );
}

export function calculateOrderQuote(
  input: QuoteOrderInput,
  catalogMap: Map<string, AuthoritativeCatalogVariant>,
): CalculatedOrderQuote {
  if (!input.lines || input.lines.length === 0) {
    throw new SalesDomainError(
      SalesDomainErrorCode.VALIDATION_ERROR,
      'Order must contain at least one line item',
      422,
    );
  }

  interface IntermediateLine {
    lineNo: number;
    catalog: AuthoritativeCatalogVariant;
    qtyMillis: bigint;
    baseQtyMillis: bigint;
    unitPriceVnd: bigint;
    lineGrossVnd: bigint;
    itemDiscountType: DiscountType;
    itemDiscountValueStr: string;
    itemDiscountVnd: bigint;
    lineAfterItemDiscountVnd: bigint;
    allocatedOrderDiscountVnd: bigint;
    taxRateBps: bigint;
    taxRateStr: string;
  }

  const interLines: IntermediateLine[] = [];
  let subtotalVnd = 0n;
  let itemDiscountTotalVnd = 0n;
  let totalBaseQtyMillis = 0n;

  for (let i = 0; i < input.lines.length; i++) {
    const reqLine = input.lines[i];
    const catalog = catalogMap.get(reqLine.variantId);
    if (!catalog) {
      throw new SalesDomainError(
        SalesDomainErrorCode.PRICE_NOT_CONFIGURED,
        `Variant ${reqLine.variantId} not found in Catalog`,
        404,
      );
    }
    if (catalog.status !== 'ACTIVE') {
      throw new SalesDomainError(
        SalesDomainErrorCode.PRODUCT_NOT_SELLABLE,
        `Variant ${catalog.skuCode} (${catalog.variantId}) has status ${catalog.status} and is not sellable`,
        409,
      );
    }

    const unitPriceVnd = parseVndAmount(catalog.unitPrice, false);
    if (
      reqLine.expectedUnitPrice !== undefined &&
      reqLine.expectedUnitPrice !== null &&
      String(reqLine.expectedUnitPrice).trim() !== ''
    ) {
      const expectedVnd = parseVndAmount(reqLine.expectedUnitPrice, false);
      if (expectedVnd !== unitPriceVnd) {
        throw new SalesDomainError(
          SalesDomainErrorCode.PRICE_CHANGED,
          `Catalog price for ${catalog.skuCode} changed from ${formatVnd(expectedVnd)} to ${formatVnd(unitPriceVnd)}`,
          409,
          {
            variantId: catalog.variantId,
            skuCode: catalog.skuCode,
            expectedUnitPrice: formatVnd(expectedVnd),
            actualUnitPrice: formatVnd(unitPriceVnd),
          },
        );
      }
    }

    const qtyMillis = parseQtyMillis(reqLine.qty);
    const factor = parseConversionFactor(catalog.conversionFactor);
    const baseQtyMillis = computeBaseQtyMillis(qtyMillis, factor);
    const lineGrossVnd = roundDivHalfUp(qtyMillis * unitPriceVnd, QTY_SCALE);

    const itemDiscountType = reqLine.discountType ?? 'NONE';
    const itemDiscountVnd = calculateItemDiscount(
      lineGrossVnd,
      itemDiscountType,
      reqLine.discountValue,
    );
    const lineAfterItemDiscountVnd = lineGrossVnd - itemDiscountVnd;

    const taxRateNum =
      reqLine.taxRatePercent !== undefined ? Number(reqLine.taxRatePercent) : 0;
    if (!Number.isFinite(taxRateNum) || taxRateNum < 0 || taxRateNum > 100) {
      throw new SalesDomainError(
        SalesDomainErrorCode.VALIDATION_ERROR,
        `Invalid tax rate percentage: ${reqLine.taxRatePercent}`,
        422,
      );
    }
    const taxRateBps = BigInt(Math.round(taxRateNum * 100));

    subtotalVnd += lineGrossVnd;
    itemDiscountTotalVnd += itemDiscountVnd;
    totalBaseQtyMillis += baseQtyMillis;

    interLines.push({
      lineNo: i + 1,
      catalog,
      qtyMillis,
      baseQtyMillis,
      unitPriceVnd,
      lineGrossVnd,
      itemDiscountType,
      itemDiscountValueStr:
        reqLine.discountValue !== undefined
          ? String(reqLine.discountValue)
          : '0.00',
      itemDiscountVnd,
      lineAfterItemDiscountVnd,
      allocatedOrderDiscountVnd: 0n,
      taxRateBps,
      taxRateStr: taxRateNum.toFixed(2),
    });
  }

  const netAfterItemDiscounts = subtotalVnd - itemDiscountTotalVnd;
  const orderDiscountType = input.orderDiscountType ?? 'NONE';
  const rawOrderDiscountVnd = calculateItemDiscount(
    netAfterItemDiscounts,
    orderDiscountType,
    input.orderDiscountValue,
  );
  const promoDiscountVnd = parseVndAmount(input.promotionDiscountAmount, true);
  if (rawOrderDiscountVnd + promoDiscountVnd > netAfterItemDiscounts) {
    throw new SalesDomainError(
      SalesDomainErrorCode.INVALID_DISCOUNT,
      `Order and promotion discount (${rawOrderDiscountVnd + promoDiscountVnd}) cannot exceed net subtotal after item discounts (${netAfterItemDiscounts})`,
      422,
    );
  }
  const combinedOrderDiscountVnd = rawOrderDiscountVnd + promoDiscountVnd;

  // Pro-rate combinedOrderDiscountVnd across lines based on lineAfterItemDiscountVnd
  if (combinedOrderDiscountVnd > 0n && netAfterItemDiscounts > 0n) {
    let allocatedSum = 0n;
    let lastPositiveIdx = -1;
    for (let i = 0; i < interLines.length; i++) {
      if (interLines[i].lineAfterItemDiscountVnd > 0n) {
        lastPositiveIdx = i;
        const share = roundDivHalfUp(
          combinedOrderDiscountVnd * interLines[i].lineAfterItemDiscountVnd,
          netAfterItemDiscounts,
        );
        interLines[i].allocatedOrderDiscountVnd = share;
        allocatedSum += share;
      }
    }
    const residual = combinedOrderDiscountVnd - allocatedSum;
    if (residual !== 0n && lastPositiveIdx >= 0) {
      interLines[lastPositiveIdx].allocatedOrderDiscountVnd += residual;
    }
  }

  let taxTotalVnd = 0n;
  const calculatedLines: CalculatedOrderLine[] = interLines.map((line) => {
    const lineNetVnd =
      line.lineAfterItemDiscountVnd - line.allocatedOrderDiscountVnd;
    const taxAmountVnd = roundDivHalfUp(lineNetVnd * line.taxRateBps, 10000n);
    const lineTotalVnd = lineNetVnd + taxAmountVnd;
    taxTotalVnd += taxAmountVnd;

    return {
      lineNo: line.lineNo,
      variantId: line.catalog.variantId,
      productId: line.catalog.productId,
      skuCode: line.catalog.skuCode,
      productName: line.catalog.productName,
      variantLabel: line.catalog.variantName,
      unitCode: line.catalog.unitCode || 'PCS',
      conversionFactor: line.catalog.conversionFactor || '1.0000',
      qty: formatQtyMillis(line.qtyMillis),
      baseQty: formatQtyMillis(line.baseQtyMillis),
      unitPrice: formatVnd(line.unitPriceVnd),
      lineGross: formatVnd(line.lineGrossVnd),
      itemDiscountType: line.itemDiscountType,
      itemDiscountValue: line.itemDiscountValueStr,
      itemDiscountAmount: formatVnd(line.itemDiscountVnd),
      lineAfterItemDiscount: formatVnd(line.lineAfterItemDiscountVnd),
      allocatedOrderDiscount: formatVnd(line.allocatedOrderDiscountVnd),
      lineNet: formatVnd(lineNetVnd),
      taxRate: line.taxRateStr,
      taxAmount: formatVnd(taxAmountVnd),
      lineTotal: formatVnd(lineTotalVnd),
      unitCostSnapshot: line.catalog.unitCostSnapshot
        ? formatVnd(parseVndAmount(line.catalog.unitCostSnapshot, true))
        : '0.00',
    };
  });

  const shippingFeeVnd = parseVndAmount(input.shippingFee, true);
  const totalDiscountVnd = itemDiscountTotalVnd + combinedOrderDiscountVnd;
  const grandTotalVnd =
    subtotalVnd - totalDiscountVnd + taxTotalVnd + shippingFeeVnd;

  const effectiveDiscountPercent =
    subtotalVnd > 0n
      ? Number(((totalDiscountVnd * 10000n) / subtotalVnd).toString()) / 100
      : 0;

  return {
    lines: calculatedLines,
    subtotal: formatVnd(subtotalVnd),
    itemDiscountTotal: formatVnd(itemDiscountTotalVnd),
    orderDiscountType,
    orderDiscountValue:
      input.orderDiscountValue !== undefined
        ? String(input.orderDiscountValue)
        : '0.00',
    orderDiscountTotal: formatVnd(rawOrderDiscountVnd),
    promotionDiscountTotal: formatVnd(promoDiscountVnd),
    totalDiscount: formatVnd(totalDiscountVnd),
    effectiveDiscountPercent,
    shippingFee: formatVnd(shippingFeeVnd),
    taxTotal: formatVnd(taxTotalVnd),
    grandTotal: formatVnd(grandTotalVnd),
    totalBaseQty: formatQtyMillis(totalBaseQtyMillis),
  };
}

// ---- RBAC Discount Authority ----

export const ROLE_MAX_DISCOUNT_PERCENT: Record<string, number> = {
  owner: 100,
  manager: 30,
  cashier: 10,
};

export function assertDiscountAuthority(params: {
  effectiveDiscountPercent: number;
  role?: string | null;
  permissions?: string[];
  discountApprovedBy?: string | null;
}): void {
  if (params.effectiveDiscountPercent <= 0) {
    return;
  }
  const perms = params.permissions ?? [];
  if (
    perms.includes('*') ||
    perms.includes('sales.pos.discount.override') ||
    params.discountApprovedBy
  ) {
    return;
  }
  const roleKey = (params.role ?? 'cashier').toLowerCase();
  const maxAllowed = ROLE_MAX_DISCOUNT_PERCENT[roleKey] ?? 10;
  if (params.effectiveDiscountPercent > maxAllowed) {
    throw new SalesDomainError(
      SalesDomainErrorCode.DISCOUNT_APPROVAL_REQUIRED,
      `Effective discount ${params.effectiveDiscountPercent.toFixed(2)}% exceeds role '${roleKey}' limit of ${maxAllowed}%`,
      403,
      {
        effectiveDiscountPercent: params.effectiveDiscountPercent,
        role: roleKey,
        maxAllowedPercent: maxAllowed,
      },
    );
  }
}

// ---- 3D Order State Machine Validation ----

export function validateOrderStateCombination(state: {
  orderStatus: CommercialOrderStatus;
  paymentStatus: OrderPaymentStatus;
  fulfillmentStatus: OrderFulfillmentStatus;
}): void {
  const { orderStatus, paymentStatus, fulfillmentStatus } = state;

  if (orderStatus === 'DRAFT' && fulfillmentStatus !== 'UNFULFILLED') {
    throw new SalesDomainError(
      SalesDomainErrorCode.ORDER_INVALID_STATE,
      `A DRAFT order cannot have fulfillmentStatus=${fulfillmentStatus}`,
      409,
    );
  }

  if (
    orderStatus === 'CANCELLED' &&
    (fulfillmentStatus === 'RESERVED' || fulfillmentStatus === 'FULFILLED')
  ) {
    throw new SalesDomainError(
      SalesDomainErrorCode.ORDER_INVALID_STATE,
      `A CANCELLED order cannot retain fulfillmentStatus=${fulfillmentStatus}`,
      409,
    );
  }

  if (
    orderStatus === 'COMPLETED' &&
    fulfillmentStatus !== 'FULFILLED' &&
    fulfillmentStatus !== 'RETURNED'
  ) {
    throw new SalesDomainError(
      SalesDomainErrorCode.ORDER_INVALID_STATE,
      `A COMPLETED order must be FULFILLED or RETURNED, got ${fulfillmentStatus}`,
      409,
    );
  }

  if (orderStatus === 'COMPLETED' && paymentStatus === 'UNPAID') {
    throw new SalesDomainError(
      SalesDomainErrorCode.ORDER_INVALID_STATE,
      'A COMPLETED order cannot have paymentStatus=UNPAID',
      409,
    );
  }
}

export function assertCanCancelOrder(state: {
  orderStatus: CommercialOrderStatus;
  fulfillmentStatus: OrderFulfillmentStatus;
}): void {
  if (state.orderStatus === 'CANCELLED') {
    throw new SalesDomainError(
      SalesDomainErrorCode.ORDER_ALREADY_CANCELLED,
      'Order is already CANCELLED',
      409,
    );
  }
  if (
    state.orderStatus === 'COMPLETED' ||
    state.fulfillmentStatus === 'FULFILLED'
  ) {
    throw new SalesDomainError(
      SalesDomainErrorCode.ORDER_ALREADY_COMPLETED,
      'Fulfilled or completed orders cannot be cancelled; use the Return workflow instead',
      409,
    );
  }
}

// ---- Tender Validation & Cash Calculation ----

export interface TenderInputLine {
  method: Exclude<TenderMethod, 'COMBINED'>;
  amount: string | number;
  tenderedCash?: string | number;
  externalRef?: string;
  verified?: boolean;
}

export interface ValidatedTenderLine {
  method: Exclude<TenderMethod, 'COMBINED'>;
  amount: string;
  tenderedCash: string;
  changeDue: string;
  status: 'CONFIRMED' | 'PENDING';
  externalRef: string | null;
}

export interface ValidatedTenderSummary {
  tenders: ValidatedTenderLine[];
  totalAllocated: string;
  totalConfirmed: string;
  totalCashSales: string;
  totalChangeDue: string;
  allConfirmed: boolean;
  paymentStatus: OrderPaymentStatus;
}

export function validateOrderTenders(
  grandTotalStr: string,
  tendersInput: TenderInputLine[],
): ValidatedTenderSummary {
  const grandTotal = parseVndAmount(grandTotalStr, true);
  if (!tendersInput || tendersInput.length === 0) {
    throw new SalesDomainError(
      SalesDomainErrorCode.PAYMENT_AMOUNT_MISMATCH,
      'At least one tender line is required',
      422,
    );
  }

  let totalAllocated = 0n;
  let totalConfirmed = 0n;
  let totalCashSales = 0n;
  let totalChangeDue = 0n;
  const validated: ValidatedTenderLine[] = [];

  for (const t of tendersInput) {
    const amount = parseVndAmount(t.amount, grandTotal === 0n);
    totalAllocated += amount;

    if (t.method === 'CASH') {
      const tendered =
        t.tenderedCash !== undefined
          ? parseVndAmount(t.tenderedCash, true)
          : amount;
      if (tendered < amount) {
        throw new SalesDomainError(
          SalesDomainErrorCode.PAYMENT_AMOUNT_MISMATCH,
          `Cash tendered (${formatVnd(tendered)}) is less than cash allocation (${formatVnd(amount)})`,
          422,
        );
      }
      const changeDue = tendered - amount;
      totalConfirmed += amount;
      totalCashSales += amount;
      totalChangeDue += changeDue;
      validated.push({
        method: 'CASH',
        amount: formatVnd(amount),
        tenderedCash: formatVnd(tendered),
        changeDue: formatVnd(changeDue),
        status: 'CONFIRMED',
        externalRef: t.externalRef ?? null,
      });
    } else if (t.method === 'COD') {
      validated.push({
        method: 'COD',
        amount: formatVnd(amount),
        tenderedCash: '0.00',
        changeDue: '0.00',
        status: 'PENDING',
        externalRef: t.externalRef ?? null,
      });
    } else {
      // BANK_TRANSFER, CARD, E_WALLET: only CONFIRMED if explicitly verified with an externalRef
      const isConfirmed = Boolean(t.verified && t.externalRef);
      if (isConfirmed) {
        totalConfirmed += amount;
      }
      validated.push({
        method: t.method,
        amount: formatVnd(amount),
        tenderedCash: '0.00',
        changeDue: '0.00',
        status: isConfirmed ? 'CONFIRMED' : 'PENDING',
        externalRef: t.externalRef ?? null,
      });
    }
  }

  if (totalAllocated !== grandTotal) {
    throw new SalesDomainError(
      SalesDomainErrorCode.PAYMENT_AMOUNT_MISMATCH,
      `Allocated tender sum (${formatVnd(totalAllocated)}) does not equal order grand total (${formatVnd(grandTotal)})`,
      422,
    );
  }

  const allConfirmed = totalConfirmed === grandTotal;
  const paymentStatus: OrderPaymentStatus = allConfirmed
    ? 'PAID'
    : totalConfirmed > 0n
      ? 'PARTIALLY_PAID'
      : 'UNPAID';

  return {
    tenders: validated,
    totalAllocated: formatVnd(totalAllocated),
    totalConfirmed: formatVnd(totalConfirmed),
    totalCashSales: formatVnd(totalCashSales),
    totalChangeDue: formatVnd(totalChangeDue),
    allConfirmed,
    paymentStatus,
  };
}

// ---- Shift Cash Reconciliation ----

export interface ShiftCashReconciliation {
  openingCash: string;
  cashSalesTotal: string;
  cashRefundsTotal: string;
  expectedCash: string;
  actualCash: string;
  variance: string;
}

export function calculateShiftCloseSummary(params: {
  openingCash: string | number;
  cashSalesTotal: string | number;
  cashRefundsTotal: string | number;
  actualCash: string | number;
}): ShiftCashReconciliation {
  const opening = parseVndAmount(params.openingCash, true);
  const sales = parseVndAmount(params.cashSalesTotal, true);
  const refunds = parseVndAmount(params.cashRefundsTotal, true);
  const actual = parseVndAmount(params.actualCash, true);

  const expected = opening + sales - refunds;
  const variance = actual - expected;

  return {
    openingCash: formatVnd(opening),
    cashSalesTotal: formatVnd(sales),
    cashRefundsTotal: formatVnd(refunds),
    expectedCash: formatVnd(expected),
    actualCash: formatVnd(actual),
    variance: `${variance < 0n ? '-' : ''}${formatVnd(variance < 0n ? -variance : variance)}`,
  };
}

// ---- Partial Return & Pro-Rated Refund Calculation ----

export interface OriginalOrderLineSnapshot {
  orderItemId: string;
  variantId: string;
  skuCode: string;
  productName: string;
  soldQty: string;
  alreadyReturnedQty: string;
  unitPrice: string;
  lineNet: string;
  taxAmount: string;
  lineTotal: string;
  alreadyRefundedAmount: string;
}

export interface ReturnLineRequest {
  orderItemId: string;
  returnQty: string | number;
  disposition: ReturnDisposition;
  reason?: string;
}

export interface CalculatedReturnLine {
  orderItemId: string;
  variantId: string;
  skuCode: string;
  productName: string;
  returnQty: string;
  remainingReturnableAfter: string;
  unitRefundAmount: string;
  refundAmount: string;
  disposition: ReturnDisposition;
  reason: string | null;
}

export interface CalculatedReturnResult {
  lines: CalculatedReturnLine[];
  totalRefundAmount: string;
  isFullOrderReturn: boolean;
}

export function calculateReturnRefund(
  originalLines: OriginalOrderLineSnapshot[],
  returnRequests: ReturnLineRequest[],
): CalculatedReturnResult {
  if (!returnRequests || returnRequests.length === 0) {
    throw new SalesDomainError(
      SalesDomainErrorCode.VALIDATION_ERROR,
      'Return request must include at least one item',
      422,
    );
  }

  const lineMap = new Map<string, OriginalOrderLineSnapshot>();
  for (const orig of originalLines) {
    lineMap.set(orig.orderItemId, orig);
  }

  // Coalesce duplicate orderItemId in request if any
  const requestedMillisByItem = new Map<string, bigint>();
  for (const req of returnRequests) {
    const orig = lineMap.get(req.orderItemId);
    if (!orig) {
      throw new SalesDomainError(
        SalesDomainErrorCode.RETURN_NOT_ELIGIBLE,
        `Order item ${req.orderItemId} does not belong to the original order`,
        409,
      );
    }
    const qtyMillis = parseQtyMillis(req.returnQty);
    const prev = requestedMillisByItem.get(req.orderItemId) ?? 0n;
    requestedMillisByItem.set(req.orderItemId, prev + qtyMillis);
  }

  // Validate against remaining returnable quantity
  for (const [orderItemId, totalReqMillis] of requestedMillisByItem.entries()) {
    const orig = lineMap.get(orderItemId)!;
    const soldMillis = parseQtyMillis(orig.soldQty);
    const returnedMillis =
      orig.alreadyReturnedQty && Number(orig.alreadyReturnedQty) > 0
        ? parseQtyMillis(orig.alreadyReturnedQty)
        : 0n;
    const remainingMillis = soldMillis - returnedMillis;
    if (totalReqMillis > remainingMillis) {
      throw new SalesDomainError(
        SalesDomainErrorCode.RETURN_QUANTITY_EXCEEDED,
        `Return quantity (${formatQtyMillis(totalReqMillis)}) exceeds remaining returnable quantity (${formatQtyMillis(remainingMillis < 0n ? 0n : remainingMillis)}) for SKU ${orig.skuCode}`,
        409,
        {
          orderItemId,
          skuCode: orig.skuCode,
          requestedQty: formatQtyMillis(totalReqMillis),
          remainingReturnableQty: formatQtyMillis(
            remainingMillis < 0n ? 0n : remainingMillis,
          ),
        },
      );
    }
  }

  let totalRefundVnd = 0n;
  const cumulativeReturnedMillis = new Map<string, bigint>();
  const cumulativeRefundedVnd = new Map<string, bigint>();

  for (const orig of originalLines) {
    const returnedMillis =
      orig.alreadyReturnedQty && Number(orig.alreadyReturnedQty) > 0
        ? parseQtyMillis(orig.alreadyReturnedQty)
        : 0n;
    cumulativeReturnedMillis.set(orig.orderItemId, returnedMillis);
    cumulativeRefundedVnd.set(
      orig.orderItemId,
      parseVndAmount(orig.alreadyRefundedAmount, true),
    );
  }

  const calculatedLines: CalculatedReturnLine[] = returnRequests.map((req) => {
    const orig = lineMap.get(req.orderItemId)!;
    const soldMillis = parseQtyMillis(orig.soldQty);
    const reqMillis = parseQtyMillis(req.returnQty);
    const prevReturnedMillis = cumulativeReturnedMillis.get(req.orderItemId)!;
    const newReturnedMillis = prevReturnedMillis + reqMillis;
    cumulativeReturnedMillis.set(req.orderItemId, newReturnedMillis);

    const lineTotalVnd = parseVndAmount(orig.lineTotal, true);
    const prevRefundedVnd = cumulativeRefundedVnd.get(req.orderItemId)!;
    const maxRemainingRefundVnd = lineTotalVnd - prevRefundedVnd;

    let refundVnd: bigint;
    if (newReturnedMillis === soldMillis) {
      // Exact residual refund when returning the final remaining units of the line
      refundVnd = maxRemainingRefundVnd;
    } else {
      refundVnd = roundDivHalfUp(lineTotalVnd * reqMillis, soldMillis);
      if (refundVnd > maxRemainingRefundVnd) {
        refundVnd = maxRemainingRefundVnd;
      }
    }

    cumulativeRefundedVnd.set(req.orderItemId, prevRefundedVnd + refundVnd);
    totalRefundVnd += refundVnd;

    const unitRefundVnd = roundDivHalfUp(refundVnd * QTY_SCALE, reqMillis);
    const remainingAfterMillis = soldMillis - newReturnedMillis;

    return {
      orderItemId: orig.orderItemId,
      variantId: orig.variantId,
      skuCode: orig.skuCode,
      productName: orig.productName,
      returnQty: formatQtyMillis(reqMillis),
      remainingReturnableAfter: formatQtyMillis(remainingAfterMillis),
      unitRefundAmount: formatVnd(unitRefundVnd),
      refundAmount: formatVnd(refundVnd),
      disposition: req.disposition,
      reason: req.reason ?? null,
    };
  });

  const isFullOrderReturn = originalLines.every((orig) => {
    const soldMillis = parseQtyMillis(orig.soldQty);
    const returnedAfter = cumulativeReturnedMillis.get(orig.orderItemId) ?? 0n;
    return returnedAfter === soldMillis;
  });

  return {
    lines: calculatedLines,
    totalRefundAmount: formatVnd(totalRefundVnd),
    isFullOrderReturn,
  };
}

// ============================================================================
// VALUE OBJECTS & ORDER AGGREGATE ROOT (M7.5 Tactical DDD)
// ============================================================================

/**
 * Immutable Value Object representing an exact VND monetary amount.
 */
export class VndMoney {
  public readonly amount: bigint;

  private constructor(amount: bigint) {
    this.amount = amount;
  }

  static of(raw: string | number | bigint, allowZero = true): VndMoney {
    return new VndMoney(parseVndAmount(raw, allowZero));
  }

  static zero(): VndMoney {
    return new VndMoney(0n);
  }

  add(other: VndMoney): VndMoney {
    return new VndMoney(this.amount + other.amount);
  }

  subtract(other: VndMoney): VndMoney {
    const next = this.amount - other.amount;
    if (next < 0n) {
      throw new SalesDomainError(
        SalesDomainErrorCode.VALIDATION_ERROR,
        `Monetary subtraction cannot produce a negative amount (${this.toString()} - ${other.toString()})`,
        422,
      );
    }
    return new VndMoney(next);
  }

  equals(other: VndMoney): boolean {
    return this.amount === other.amount;
  }

  isPositive(): boolean {
    return this.amount > 0n;
  }

  toString(): string {
    return formatVnd(this.amount);
  }
}

/**
 * Immutable Value Object representing a positive stock quantity in NUMERIC(18,3) milli-units.
 */
export class StockQuantity {
  public readonly millis: bigint;

  private constructor(millis: bigint) {
    this.millis = millis;
  }

  static of(raw: string | number): StockQuantity {
    return new StockQuantity(parseQtyMillis(raw));
  }

  add(other: StockQuantity): StockQuantity {
    return new StockQuantity(this.millis + other.millis);
  }

  toBaseQuantity(conversionFactor?: string | number | null): StockQuantity {
    const factor = parseConversionFactor(conversionFactor);
    return new StockQuantity(computeBaseQtyMillis(this.millis, factor));
  }

  equals(other: StockQuantity): boolean {
    return this.millis === other.millis;
  }

  toString(): string {
    return formatQtyMillis(this.millis);
  }
}

/**
 * Immutable Value Object representing a validated discount percentage (0..100).
 */
export class DiscountPercentage {
  public readonly value: number;
  public readonly basisPoints: bigint;

  private constructor(value: number, basisPoints: bigint) {
    this.value = value;
    this.basisPoints = basisPoints;
  }

  static of(raw: string | number): DiscountPercentage {
    const num = Number(raw);
    if (!Number.isFinite(num) || num < 0 || num > 100) {
      throw new SalesDomainError(
        SalesDomainErrorCode.INVALID_DISCOUNT,
        `Discount percentage must be between 0 and 100, got ${raw}`,
        422,
      );
    }
    return new DiscountPercentage(num, BigInt(Math.round(num * 100)));
  }
}

export interface OrderStateTransitionRecord {
  fromOrderStatus: CommercialOrderStatus;
  toOrderStatus: CommercialOrderStatus;
  fromPaymentStatus: OrderPaymentStatus;
  toPaymentStatus: OrderPaymentStatus;
  fromFulfillmentStatus: OrderFulfillmentStatus;
  toFulfillmentStatus: OrderFulfillmentStatus;
  reason: string;
}

/**
 * Rich Aggregate Root protecting the 3D state machine (CommercialOrderStatus x
 * OrderPaymentStatus x OrderFulfillmentStatus), optimistic concurrency version,
 * and fulfillment/cancellation invariants of a Sales Order.
 */
export class OrderAggregate {
  constructor(
    public readonly id: string,
    public readonly tenantId: string,
    public readonly code: string,
    private _orderStatus: CommercialOrderStatus,
    private _paymentStatus: OrderPaymentStatus,
    private _fulfillmentStatus: OrderFulfillmentStatus,
    private _version: number = 1,
    private _warehouseId: string | null = null,
    private _reservationId: string | null = null,
    private _completedAt: Date | null = null,
    private _cancelledAt: Date | null = null,
    private _cancelReason: string | null = null,
  ) {
    validateOrderStateCombination({
      orderStatus: this._orderStatus,
      paymentStatus: this._paymentStatus,
      fulfillmentStatus: this._fulfillmentStatus,
    });
  }

  get orderStatus(): CommercialOrderStatus {
    return this._orderStatus;
  }

  get legacyStatus(): string {
    return this._orderStatus.toLowerCase();
  }

  get paymentStatus(): OrderPaymentStatus {
    return this._paymentStatus;
  }

  get fulfillmentStatus(): OrderFulfillmentStatus {
    return this._fulfillmentStatus;
  }

  get version(): number {
    return this._version;
  }

  get warehouseId(): string | null {
    return this._warehouseId;
  }

  get reservationId(): string | null {
    return this._reservationId;
  }

  get completedAt(): Date | null {
    return this._completedAt;
  }

  get cancelledAt(): Date | null {
    return this._cancelledAt;
  }

  get cancelReason(): string | null {
    return this._cancelReason;
  }

  /**
   * Verifies that the order is in an editable pre-confirmation state (DRAFT or PENDING)
   * and optionally checks optimistic concurrency version.
   */
  assertEditable(expectedVersion?: number): void {
    if (
      expectedVersion !== undefined &&
      Number(this._version) !== Number(expectedVersion)
    ) {
      throw new SalesDomainError(
        SalesDomainErrorCode.RESOURCE_VERSION_CONFLICT,
        `Order ${this.code} version mismatch (expected ${expectedVersion}, actual ${this._version})`,
        409,
      );
    }
    if (this._orderStatus !== 'DRAFT' && this._orderStatus !== 'PENDING') {
      throw new SalesDomainError(
        SalesDomainErrorCode.ORDER_INVALID_STATE,
        `Order ${this.code} in status ${this._orderStatus} cannot be edited`,
        409,
      );
    }
  }

  bumpVersion(): number {
    this._version = Number(this._version) + 1;
    return this._version;
  }

  /**
   * Validates that an order is eligible to be confirmed and reserved.
   */
  assertCanConfirm(): void {
    if (this._orderStatus !== 'DRAFT' && this._orderStatus !== 'PENDING') {
      throw new SalesDomainError(
        SalesDomainErrorCode.ORDER_INVALID_STATE,
        `Cannot confirm order in status ${this._orderStatus}`,
        409,
      );
    }
  }

  /**
   * Transitions the order to CONFIRMED + RESERVED once stock reservation succeeds.
   */
  confirmWithReservation(
    warehouseId: string,
    reservationId: string,
  ): OrderStateTransitionRecord {
    this.assertCanConfirm();
    const prevOrder = this._orderStatus;
    const prevFulfill = this._fulfillmentStatus;

    this._warehouseId = warehouseId;
    this._reservationId = reservationId;
    this._orderStatus = 'CONFIRMED';
    this._fulfillmentStatus = 'RESERVED';
    validateOrderStateCombination({
      orderStatus: this._orderStatus,
      paymentStatus: this._paymentStatus,
      fulfillmentStatus: this._fulfillmentStatus,
    });
    this.bumpVersion();

    return {
      fromOrderStatus: prevOrder,
      toOrderStatus: this._orderStatus,
      fromPaymentStatus: this._paymentStatus,
      toPaymentStatus: this._paymentStatus,
      fromFulfillmentStatus: prevFulfill,
      toFulfillmentStatus: this._fulfillmentStatus,
      reason: 'ORDER_CONFIRMED_AND_RESERVED',
    };
  }

  /**
   * Validates and executes order cancellation, returning the transition record.
   */
  cancel(reason?: string, now: Date = new Date()): OrderStateTransitionRecord {
    assertCanCancelOrder({
      orderStatus: this._orderStatus,
      fulfillmentStatus: this._fulfillmentStatus,
    });
    const prevOrder = this._orderStatus;
    const prevFulfill = this._fulfillmentStatus;

    this._orderStatus = 'CANCELLED';
    this._fulfillmentStatus = 'UNFULFILLED';
    this._cancelReason = reason ?? 'CANCELLED_BY_USER';
    this._cancelledAt = now;
    validateOrderStateCombination({
      orderStatus: this._orderStatus,
      paymentStatus: this._paymentStatus,
      fulfillmentStatus: this._fulfillmentStatus,
    });
    this.bumpVersion();

    return {
      fromOrderStatus: prevOrder,
      toOrderStatus: this._orderStatus,
      fromPaymentStatus: this._paymentStatus,
      toPaymentStatus: this._paymentStatus,
      fromFulfillmentStatus: prevFulfill,
      toFulfillmentStatus: this._fulfillmentStatus,
      reason: reason ?? 'ORDER_CANCELLED',
    };
  }

  /**
   * Validates that a fulfillment shipment can be created for this order.
   */
  assertCanCreateFulfillment(): void {
    if (this._orderStatus === 'CANCELLED' || this._orderStatus === 'DRAFT') {
      throw new SalesDomainError(
        SalesDomainErrorCode.FULFILLMENT_INVALID_STATE,
        `Cannot create fulfillment for order in status ${this._orderStatus}`,
        409,
      );
    }
  }

  /**
   * Transitions fulfillmentStatus to FULFILLED and auto-completes the order if PAID.
   */
  markFulfilled(
    fulfillmentCode: string,
    now: Date = new Date(),
  ): OrderStateTransitionRecord {
    const prevOrder = this._orderStatus;
    const prevFulfill = this._fulfillmentStatus;

    this._fulfillmentStatus = 'FULFILLED';
    if (this._paymentStatus === 'PAID') {
      this._orderStatus = 'COMPLETED';
      this._completedAt = now;
    }
    validateOrderStateCombination({
      orderStatus: this._orderStatus,
      paymentStatus: this._paymentStatus,
      fulfillmentStatus: this._fulfillmentStatus,
    });
    this.bumpVersion();

    return {
      fromOrderStatus: prevOrder,
      toOrderStatus: this._orderStatus,
      fromPaymentStatus: this._paymentStatus,
      toPaymentStatus: this._paymentStatus,
      fromFulfillmentStatus: prevFulfill,
      toFulfillmentStatus: this._fulfillmentStatus,
      reason: `FULFILLMENT_CONFIRMED:${fulfillmentCode}`,
    };
  }
}
