import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { roundVnd } from '../../common/money';
import {
  IntegrationDomainError,
  IntegrationDomainErrorCode,
  assertWebhookTimestampFreshness,
  computeLazadaApiSignature,
  normalizeProviderOrderStatus,
  verifyLazadaWebhookSignature,
} from '../../domain/integration-domain';
import { ProviderRateLimiterService } from '../../infrastructure/rate-limiting/provider-rate-limiter.service';
import type {
  ExternalProductListingVariation,
  InventoryPublicationCommand,
  InventoryPublicationResult,
  MarketplaceProviderAdapter,
  NormalizedExternalOrder,
  NormalizedWebhookEnvelope,
  OAuthAuthorizationUrlResult,
  ProviderCapabilityDeclaration,
  TokenExchangeResult,
} from '../contracts/provider.contracts';

@Injectable()
export class LazadaProviderAdapter implements MarketplaceProviderAdapter {
  readonly provider = 'LAZADA' as const;

  constructor(private readonly rateLimiter: ProviderRateLimiterService) {}

  getCapabilities(): ProviderCapabilityDeclaration {
    const liveConfigured = Boolean(
      process.env.LAZADA_APP_KEY &&
        process.env.LAZADA_APP_SECRET &&
        process.env.LAZADA_LIVE_ENABLED === 'true',
    );
    return {
      provider: 'LAZADA',
      apiVersion: 'rest-v2',
      supportsOAuth: true,
      supportsTokenRefresh: true,
      supportsWebhookSignatureVerification: true,
      supportsIncrementalOrderPolling: true,
      supportsBatchOrderFetch: true,
      supportsInventoryPublication: false, // disabled: no writes to live seller in read-only MVP
      supportsProductListingDiscovery: true,
      liveCredentialsConfigured: liveConfigured,
    };
  }

  buildAuthorizationUrl(params: {
    connectionId: string;
    externalShopId: string;
    redirectUri: string;
    stateNonce: string;
    partnerId: string;
    partnerSecret: string;
  }): OAuthAuthorizationUrlResult {
    const baseUrl =
      process.env.LAZADA_AUTH_URL || 'https://auth.lazada.com/oauth/authorize';
    const authorizationUrl = `${baseUrl}?response_type=code&force_auth=true&redirect_uri=${encodeURIComponent(params.redirectUri)}&client_id=${encodeURIComponent(params.partnerId)}&state=${encodeURIComponent(params.stateNonce)}`;
    return {
      authorizationUrl,
      stateNonce: params.stateNonce,
      expiresInSeconds: 300,
    };
  }

  /**
   * The published Lazada Auth API accepts signed system/business parameters.
   * Never fabricate tokens; the seller must genuinely authorize this app.
   */
  private async callAuthApi(
    apiPath: '/auth/token/create' | '/auth/token/refresh',
    input: { code?: string; refresh_token?: string; appKey: string; appSecret: string },
  ): Promise<Record<string, any>> {
    if (process.env.LAZADA_LIVE_ENABLED !== 'true') {
      throw new IntegrationDomainError(
        IntegrationDomainErrorCode.PROVIDER_UNAVAILABLE,
        'Lazada live API is not enabled',
        503,
      );
    }
    if (!input.appKey || !input.appSecret ||
        input.appKey !== process.env.LAZADA_APP_KEY ||
        input.appSecret !== process.env.LAZADA_APP_SECRET) {
      throw new IntegrationDomainError(
        IntegrationDomainErrorCode.CHANNEL_AUTHORIZATION_FAILED,
        'Lazada application credentials are not configured consistently',
        503,
      );
    }
    const payload: Record<string, string> = {
      app_key: input.appKey,
      timestamp: Date.now().toString(),
      sign_method: 'sha256',
    };
    if (input.code) payload.code = input.code;
    if (input.refresh_token) payload.refresh_token = input.refresh_token;
    payload.sign = computeLazadaApiSignature({
      appSecret: input.appSecret,
      apiPath,
      queryParams: payload,
    });
    const root = (process.env.LAZADA_AUTH_API_BASE_URL || 'https://auth.lazada.com/rest')
      .replace(/\/+$/, '');
    if (!root.startsWith('https://auth.lazada.com/rest')) {
      throw new IntegrationDomainError(
        IntegrationDomainErrorCode.CHANNEL_AUTHORIZATION_FAILED,
        'Unsupported Lazada auth API host',
        503,
      );
    }
    let response: Response;
    try {
      response = await fetch(root + apiPath, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(payload).toString(),
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new IntegrationDomainError(
        IntegrationDomainErrorCode.PROVIDER_UNAVAILABLE,
        'Lazada authorization API could not be reached',
        503,
      );
    }
    if (!response.ok) {
      throw new IntegrationDomainError(
        IntegrationDomainErrorCode.CHANNEL_AUTHORIZATION_FAILED,
        'Lazada authorization API rejected the request',
        502,
      );
    }
    let body: Record<string, any>;
    try {
      body = await response.json() as Record<string, any>;
    } catch {
      throw new IntegrationDomainError(
        IntegrationDomainErrorCode.CHANNEL_AUTHORIZATION_FAILED,
        'Invalid Lazada authorization API response',
        502,
      );
    }
    if (String(body.code) !== '0' || !body.access_token || !body.refresh_token) {
      // Do not log or return the raw token-bearing provider response.
      throw new IntegrationDomainError(
        IntegrationDomainErrorCode.CHANNEL_AUTHORIZATION_FAILED,
        'Lazada token exchange was rejected by the provider',
        401,
      );
    }
    return body;
  }

  private tokenResult(
    body: Record<string, any>,
    fallbackShopId?: string,
  ): TokenExchangeResult {
    const countryUsers = Array.isArray(body.country_user_info) ? body.country_user_info : [];
    const vnSeller = countryUsers.find(
      (entry: Record<string, unknown>) => String(entry.country ?? '').toLowerCase() === 'vn',
    );
    if (String(body.country ?? '').toLowerCase() !== 'vn' && !vnSeller) {
      throw new IntegrationDomainError(
        IntegrationDomainErrorCode.CHANNEL_AUTHORIZATION_FAILED,
        'Lazada account is not authorized for the Vietnam marketplace',
        403,
      );
    }
    const externalShopId = String(
      vnSeller?.seller_id ?? vnSeller?.short_code ?? body.account_id ?? fallbackShopId ?? '',
    ).trim();
    if (!externalShopId) {
      throw new IntegrationDomainError(
        IntegrationDomainErrorCode.CHANNEL_AUTHORIZATION_FAILED,
        'Authorized Lazada seller identity is missing',
        502,
      );
    }
    const expiresInSeconds = Number(body.expires_in);
    const refreshSeconds = Number(body.refresh_expires_in);
    if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0 ||
        !Number.isFinite(refreshSeconds) || refreshSeconds <= 0) {
      throw new IntegrationDomainError(
        IntegrationDomainErrorCode.CHANNEL_AUTHORIZATION_FAILED,
        'Lazada token expiration metadata is invalid',
        502,
      );
    }
    const now = Date.now();
    return {
      externalShopId,
      shopName: 'Lazada Shop ' + externalShopId,
      accessToken: String(body.access_token),
      refreshToken: String(body.refresh_token),
      accessTokenExpiresAt: new Date(now + expiresInSeconds * 1000),
      refreshTokenExpiresAt: new Date(now + refreshSeconds * 1000),
      scopes: [],
      liveMode: true,
    };
  }

  async exchangeAuthorizationCode(params: {
    connectionId: string;
    code: string;
    externalShopId: string;
    partnerId: string;
    partnerSecret: string;
  }): Promise<TokenExchangeResult> {
    if (!params.code || params.code.trim().length < 4) {
      throw new IntegrationDomainError(
        IntegrationDomainErrorCode.CHANNEL_AUTHORIZATION_FAILED,
        'Lazada authorization code is invalid',
        400,
      );
    }
    const body = await this.callAuthApi('/auth/token/create', {
      code: params.code,
      appKey: params.partnerId,
      appSecret: params.partnerSecret,
    });
    return this.tokenResult(body);
  }

  async refreshAccessToken(params: {
    connectionId: string;
    externalShopId: string;
    refreshToken: string;
    partnerId: string;
    partnerSecret: string;
  }): Promise<TokenExchangeResult> {
    if (!params.refreshToken) {
      throw new IntegrationDomainError(
        IntegrationDomainErrorCode.CHANNEL_REAUTH_REQUIRED,
        'Missing Lazada refresh token',
        401,
      );
    }
    const body = await this.callAuthApi('/auth/token/refresh', {
      refresh_token: params.refreshToken,
      appKey: params.partnerId,
      appSecret: params.partnerSecret,
    });
    return this.tokenResult(body, params.externalShopId);
  }

  verifyAndParseWebhook(params: {
    webhookUrl: string;
    rawBody: Buffer | string;
    headers: Record<string, string | string[] | undefined>;
    webhookSecret: string;
    nowMs?: number;
  }): NormalizedWebhookEnvelope {
    const sigHeader =
      params.headers['authorization'] ??
      params.headers['x-lazada-signature'] ??
      '';
    const providedSignature = Array.isArray(sigHeader)
      ? sigHeader[0]
      : sigHeader;

    const valid = verifyLazadaWebhookSignature({
      rawBody: params.rawBody,
      appSecret: params.webhookSecret,
      providedSignature: providedSignature ?? '',
    });

    if (!valid) {
      throw new IntegrationDomainError(
        IntegrationDomainErrorCode.INVALID_WEBHOOK_SIGNATURE,
        'Lazada webhook HMAC-SHA256 signature verification failed',
        401,
      );
    }

    let parsed: Record<string, any>;
    try {
      const str = Buffer.isBuffer(params.rawBody)
        ? params.rawBody.toString('utf8')
        : params.rawBody;
      parsed = JSON.parse(str);
    } catch {
      throw new IntegrationDomainError(
        IntegrationDomainErrorCode.WEBHOOK_PAYLOAD_UNSUPPORTED,
        'Invalid JSON in Lazada webhook body',
        400,
      );
    }

    const timestampSec = Number(parsed.timestamp ?? 0);
    assertWebhookTimestampFreshness(timestampSec, params.nowMs);

    const sellerId = String(parsed.seller_id ?? parsed.shop_id ?? '');
    if (!sellerId) {
      throw new IntegrationDomainError(
        IntegrationDomainErrorCode.WEBHOOK_PAYLOAD_UNSUPPORTED,
        'Missing seller_id in Lazada webhook payload',
        422,
      );
    }

    const msgType = Number(parsed.message_type ?? 0);
    const data = (parsed.data ?? {}) as Record<string, any>;
    const orderId = data.trade_order_id
      ? String(data.trade_order_id)
      : data.order_id
        ? String(data.order_id)
        : null;
    const status = data.order_status
      ? String(data.order_status)
      : data.status
        ? String(data.status)
        : null;
    const updateTimeSec = Number(data.status_update_time ?? timestampSec);

    let eventType: NormalizedWebhookEnvelope['eventType'] = 'UNKNOWN';
    if (msgType === 0) {
      eventType =
        status?.toLowerCase() === 'canceled' ||
        status?.toLowerCase() === 'cancelled'
          ? 'ORDER_CANCELLED'
          : 'ORDER_STATUS_UPDATE';
    } else if (msgType === 10) {
      eventType = 'AUTH_EXPIRED';
    }

    const externalEventId = parsed.message_id
      ? String(parsed.message_id)
      : `lzd:${sellerId}:${msgType}:${orderId ?? 'none'}:${status ?? 'none'}:${updateTimeSec}`;

    return {
      provider: 'LAZADA',
      externalEventId,
      deduplicationKey: externalEventId,
      eventType,
      externalShopId: sellerId,
      externalOrderId: orderId,
      externalStatus: status,
      providerEventTime: new Date(updateTimeSec * 1000),
      parsedPayload: parsed,
    };
  }

  normalizeOrderPayload(
    rawOrder: Record<string, any>,
    defaultExternalShopId: string,
  ): NormalizedExternalOrder {
    const externalOrderId = String(
      rawOrder.order_id ??
        rawOrder.trade_order_id ??
        rawOrder.externalOrderId ??
        '',
    ).trim();
    if (!externalOrderId) {
      throw new IntegrationDomainError(
        IntegrationDomainErrorCode.WEBHOOK_PAYLOAD_UNSUPPORTED,
        'Lazada order payload is missing order_id',
        422,
      );
    }

    const statuses = Array.isArray(rawOrder.statuses)
      ? rawOrder.statuses
      : [rawOrder.order_status ?? rawOrder.status ?? 'pending'];
    const rawStatus = String(statuses[0] ?? 'pending');
    const normalizedStatus = normalizeProviderOrderStatus('LAZADA', rawStatus);

    const itemList = Array.isArray(rawOrder.order_items)
      ? rawOrder.order_items
      : Array.isArray(rawOrder.lines)
        ? rawOrder.lines
        : [];

    if (itemList.length === 0) {
      throw new IntegrationDomainError(
        IntegrationDomainErrorCode.WEBHOOK_PAYLOAD_UNSUPPORTED,
        `Lazada order ${externalOrderId} has no order_items lines`,
        422,
      );
    }

    const lines = itemList.map((item: Record<string, any>) => ({
      externalItemId: String(
        item.product_id ?? item.item_id ?? item.externalItemId ?? '',
      ).trim(),
      externalSkuId: String(
        item.sku_id ?? item.externalSkuId ?? item.product_id ?? '',
      ).trim(),
      externalSkuCode: item.sku
        ? String(item.sku)
        : (item.externalSkuCode ?? null),
      itemName: String(item.name ?? item.itemName ?? 'Lazada Item'),
      quantity: Number(item.quantity ?? 1),
      unitPrice: roundVnd(
        item.item_price ?? item.paid_price ?? item.unitPrice ?? 0,
      ),
      lineDiscount: roundVnd(item.voucher_amount ?? item.lineDiscount ?? 0),
    }));

    const shippingFee = roundVnd(
      rawOrder.shipping_fee ?? rawOrder.shippingFee ?? 0,
    );
    const linesSubtotal = lines.reduce(
      (acc, l) => acc + Math.round(l.quantity * l.unitPrice) - l.lineDiscount,
      0,
    );
    const totalAmount = roundVnd(
      rawOrder.price ?? rawOrder.total_amount ?? linesSubtotal + shippingFee,
    );
    const parsedUpdatedAt = rawOrder.updated_at ? Date.parse(String(rawOrder.updated_at)) : NaN;
    const updateTimeSec = Number(rawOrder.updated_at_sec ?? (Number.isFinite(parsedUpdatedAt) ? Math.floor(parsedUpdatedAt / 1000) : Date.now() / 1000));

    return {
      provider: 'LAZADA',
      externalShopId: String(rawOrder.seller_id ?? defaultExternalShopId),
      externalOrderId,
      externalStatus: rawStatus,
      normalizedStatus,
      externalUpdatedAt: new Date(updateTimeSec * 1000),
      buyerName: String(
        rawOrder.customer_first_name ?? rawOrder.buyerName ?? 'Lazada Buyer',
      ),
      currency: String(rawOrder.currency ?? 'VND'),
      totalAmount,
      shippingFee,
      paymentMethod: String(rawOrder.payment_method ?? 'COD'),
      lines,
      rawPayload: rawOrder,
    };
  }

  private async callShopApi(
    apiPath: string,
    params: Record<string, string>,
    accessToken: string,
    appKey: string,
    appSecret: string,
  ): Promise<Record<string, any>> {
    if (process.env.LAZADA_LIVE_ENABLED !== 'true') {
      throw new IntegrationDomainError(
        IntegrationDomainErrorCode.PROVIDER_UNAVAILABLE,
        'Lazada live order API is not enabled',
        503,
      );
    }
    if (!accessToken || appKey !== process.env.LAZADA_APP_KEY ||
        appSecret !== process.env.LAZADA_APP_SECRET) {
      throw new IntegrationDomainError(
        IntegrationDomainErrorCode.CHANNEL_AUTHORIZATION_FAILED,
        'Lazada seller token or server credentials are missing',
        401,
      );
    }
    const payload: Record<string, string> = {
      app_key: appKey, access_token: accessToken,
      timestamp: Date.now().toString(), sign_method: 'sha256',
      ...params,
    };
    const sign = computeLazadaApiSignature({
      appSecret, apiPath, queryParams: payload,
    });
    const url = new URL('https://api.lazada.vn/rest' + apiPath);
    for (const [key, value] of Object.entries(payload)) url.searchParams.set(key, value);
    url.searchParams.set('sign', sign);
    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method: 'GET', signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new IntegrationDomainError(
        IntegrationDomainErrorCode.PROVIDER_UNAVAILABLE,
        'Lazada order API request timed out or could not be reached',
        503,
      );
    }
    if (!response.ok) {
      throw new IntegrationDomainError(
        IntegrationDomainErrorCode.PROVIDER_UNAVAILABLE,
        'Lazada API returned an unsuccessful HTTP status',
        response.status === 429 ? 429 : 502,
      );
    }
    let body: Record<string, any>;
    try {
      body = await response.json() as Record<string, any>;
    } catch {
      throw new IntegrationDomainError(
        IntegrationDomainErrorCode.PROVIDER_UNAVAILABLE,
        'Lazada order API returned invalid JSON',
        502,
      );
    }
    if (String(body.code) !== '0') {
      // Never leak the URL (which contains access_token) or response containing buyer PII.
      throw new IntegrationDomainError(
        IntegrationDomainErrorCode.PROVIDER_UNAVAILABLE,
        'Lazada API rejected the signed order request',
        502,
      );
    }
    return body;
  }

  async fetchOrderDetails(params: {
    tenantId: string;
    connectionId: string;
    externalShopId: string;
    externalOrderId: string;
    accessToken: string;
    partnerSecret: string;
    partnerId?: string | null;
  }): Promise<NormalizedExternalOrder> {
    return this.rateLimiter.executeGuardedProviderCall(
      {
        tenantId: params.tenantId,
        connectionId: params.connectionId,
        provider: 'LAZADA',
        operation: 'order_items_get',
        endpoint: '/order/items/get',
      },
      async () => {
        if (process.env.LAZADA_LIVE_ENABLED !== 'true') {
          if (process.env.NODE_ENV === 'test' || process.env.LAZADA_SIMULATOR_ENABLED === 'true') {
            const seeded = this.rateLimiter.getSimulatedOrder(
              params.connectionId, params.externalOrderId,
            );
            if (seeded) return seeded;
          }
          throw new IntegrationDomainError(
            IntegrationDomainErrorCode.PROVIDER_UNAVAILABLE,
            'Lazada live API is disabled; no actual order fetched',
            503,
          );
        }
        const key = params.partnerId || process.env.LAZADA_APP_KEY!;
        const [order, items] = await Promise.all([
          this.callShopApi('/order/get', { order_id: params.externalOrderId },
            params.accessToken, key, params.partnerSecret),
          this.callShopApi('/order/items/get', { order_id: params.externalOrderId },
            params.accessToken, key, params.partnerSecret),
        ]);
        const rawOrder = order.data ?? {};
        const itemList = Array.isArray(items.data)
          ? items.data
          : (Array.isArray(items.data?.order_items) ? items.data.order_items : []);
        if (!rawOrder.order_id || itemList.length === 0) {
          throw new IntegrationDomainError(
            IntegrationDomainErrorCode.WEBHOOK_PAYLOAD_UNSUPPORTED,
            'Lazada order or order items were missing',
            502,
          );
        }
        return this.normalizeOrderPayload(
          { ...rawOrder, order_items: itemList },
          params.externalShopId,
        );
      },
    );
  }

  async pollUpdatedOrders(params: {
    tenantId: string;
    connectionId: string;
    externalShopId: string;
    windowStart: Date;
    windowEnd: Date;
    cursor?: string | null;
    accessToken: string;
    partnerSecret: string;
    partnerId?: string | null;
  }): Promise<{
    orders: NormalizedExternalOrder[];
    nextCursor: string | null;
    hasMore: boolean;
  }> {
    return this.rateLimiter.executeGuardedProviderCall(
      {
        tenantId: params.tenantId,
        connectionId: params.connectionId,
        provider: 'LAZADA',
        operation: 'orders_get',
        endpoint: '/orders/get',
      },
      async () => {
        if (process.env.LAZADA_LIVE_ENABLED !== 'true') {
          if (process.env.NODE_ENV === 'test' || process.env.LAZADA_SIMULATOR_ENABLED === 'true') {
            const all = this.rateLimiter.listSimulatedOrders(params.connectionId);
            return {
              orders: all.filter((o) =>
                o.externalUpdatedAt.getTime() >= params.windowStart.getTime() &&
                o.externalUpdatedAt.getTime() <= params.windowEnd.getTime(),
              ),
              nextCursor: null, hasMore: false,
            };
          }
          throw new IntegrationDomainError(
            IntegrationDomainErrorCode.PROVIDER_UNAVAILABLE,
            'Lazada live API is disabled; no actual orders fetched',
            503,
          );
        }
        const offset = params.cursor ? Number(params.cursor) : 0;
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) {
          throw new IntegrationDomainError(
            IntegrationDomainErrorCode.VALIDATION_ERROR,
            'Invalid Lazada orders pagination offset',
            400,
          );
        }
        const limit = 20;
        const result = await this.callShopApi('/orders/get', {
          update_after: params.windowStart.toISOString(),
          update_before: params.windowEnd.toISOString(),
          sort_by: 'updated_at',
          sort_direction: 'ASC',
          offset: String(offset), limit: String(limit),
        }, params.accessToken, params.partnerId || process.env.LAZADA_APP_KEY!, params.partnerSecret);
        const rawOrders = result.data?.orders;
        if (!Array.isArray(rawOrders)) {
          throw new IntegrationDomainError(
            IntegrationDomainErrorCode.PROVIDER_UNAVAILABLE,
            'Lazada returned an invalid orders collection',
            502,
          );
        }
        const orders: NormalizedExternalOrder[] = [];
        for (const order of rawOrders) {
          const orderId = String(order.order_id ?? '').trim();
          if (!orderId) throw new IntegrationDomainError(
            IntegrationDomainErrorCode.PROVIDER_UNAVAILABLE,
            'Lazada order is missing its order_id',
            502,
          );
          orders.push(await this.fetchOrderDetails({
            tenantId: params.tenantId, connectionId: params.connectionId,
            externalShopId: params.externalShopId,
            externalOrderId: orderId,
            accessToken: params.accessToken,
            partnerId: params.partnerId, partnerSecret: params.partnerSecret,
          }));
        }
        const countTotal = Number(result.data?.countTotal);
        const hasMore = Number.isFinite(countTotal)
          ? offset + rawOrders.length < countTotal
          : rawOrders.length === limit;
        return {
          orders,
          nextCursor: hasMore ? String(offset + rawOrders.length) : null,
          hasMore,
        };
      },
    );
  }

  async publishInventoryStock(
    command: InventoryPublicationCommand,
  ): Promise<InventoryPublicationResult> {
    if (process.env.LAZADA_LIVE_ENABLED === 'true') {
      throw new IntegrationDomainError(
        IntegrationDomainErrorCode.PROVIDER_CAPABILITY_UNSUPPORTED,
        'Lazada inventory write-back is disabled in the read-only MVP',
        403,
      );
    }
    const apiPath = '/product/price_quantity/update';
    const timestamp = Date.now();
    const requestSignature = computeLazadaApiSignature({
      appSecret: command.partnerSecret,
      apiPath,
      queryParams: {
        access_token: command.accessToken,
        app_key: command.partnerId ?? 'lazada-app',
        sign_method: 'sha256',
        timestamp,
      },
    });

    return this.rateLimiter.executeGuardedProviderCall(
      {
        tenantId: command.tenantId,
        connectionId: command.connectionId,
        provider: 'LAZADA',
        operation: 'price_quantity_update',
        endpoint: apiPath,
        capacityPerSec: 15,
      },
      async () => {
        this.rateLimiter.recordSimulatedRemoteStock(
          command.connectionId,
          command.externalItemId,
          command.externalSkuId,
          command.quantity,
          command.stockVersion,
        );
        return {
          provider: 'LAZADA',
          externalItemId: command.externalItemId,
          externalSkuId: command.externalSkuId,
          confirmedQuantity: command.quantity,
          providerRequestId: `lzd-stk-${randomUUID().slice(0, 12)}`,
          signedEndpoint: `${apiPath}?timestamp=${timestamp}`,
          requestSignature,
          liveExecuted: this.getCapabilities().liveCredentialsConfigured,
        };
      },
    );
  }

  async fetchExternalListings(params: {
    tenantId: string;
    connectionId: string;
    externalShopId: string;
    accessToken: string;
    partnerSecret: string;
    partnerId?: string | null;
  }): Promise<ExternalProductListingVariation[]> {
    return this.rateLimiter.executeGuardedProviderCall(
      {
        tenantId: params.tenantId,
        connectionId: params.connectionId,
        provider: 'LAZADA',
        operation: 'products_get',
        endpoint: '/products/get',
      },
      async () => {
        if (process.env.LAZADA_LIVE_ENABLED !== 'true') {
          if (process.env.NODE_ENV === 'test' || process.env.LAZADA_SIMULATOR_ENABLED === 'true') {
            return this.rateLimiter.getSimulatedListings(params.connectionId);
          }
          throw new IntegrationDomainError(
            IntegrationDomainErrorCode.PROVIDER_UNAVAILABLE,
            'Live Lazada product listing access is disabled',
            503,
          );
        }
        const response = await this.callShopApi('/products/get', {
          filter: 'all', limit: '50', offset: '0',
        }, params.accessToken, params.partnerId || process.env.LAZADA_APP_KEY!, params.partnerSecret);
        const products = response.data?.products;
        if (!Array.isArray(products)) {
          throw new IntegrationDomainError(
            IntegrationDomainErrorCode.PROVIDER_UNAVAILABLE,
            'Lazada returned an invalid products collection',
            502,
          );
        }
        const listings: ExternalProductListingVariation[] = [];
        for (const product of products) {
          const itemId = String(product.item_id ?? '').trim();
          if (!itemId) continue;
          const productName = String(product.attributes?.name ?? product.name ?? 'Lazada Product');
          const skus = Array.isArray(product.skus) ? product.skus : [];
          for (const sku of skus) {
            const skuId = String(sku.SkuId ?? sku.sku_id ?? '').trim();
            if (!skuId) continue;
            listings.push({
              externalItemId: itemId,
              externalSkuId: skuId,
              externalSkuCode: String(sku.SellerSku ?? sku.seller_sku ?? '').trim() || null,
              externalProductName: productName,
              price: Number(sku.price ?? sku.special_price ?? 0),
              stock: Number(sku.quantity ?? 0),
              status: sku.Status === 'inactive' ? 'INACTIVE' : 'ACTIVE',
            });
          }
        }
        return listings;
      },
    );
  }

}
