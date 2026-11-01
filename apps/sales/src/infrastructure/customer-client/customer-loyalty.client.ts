import { Injectable, Logger } from '@nestjs/common';
import { TenantContext } from '@pbl/common';

export interface LoyaltyHoldView {
  id: string;
  tenantId: string;
  customerId: string;
  orderId: string | null;
  checkoutId: string | null;
  points: number;
  status: 'HELD' | 'COMMITTED' | 'RELEASED' | 'EXPIRED';
  idempotencyKey: string;
}

export interface CustomerLoyaltyDelegate {
  createHold(params: {
    tenantId: string;
    actorId: string;
    customerId: string;
    orderId: string;
    checkoutId: string;
    points: number;
    idempotencyKey: string;
  }): Promise<{ hold: LoyaltyHoldView; idempotentReplay: boolean }>;
  commitHold(params: {
    tenantId: string;
    actorId: string;
    holdId: string;
    orderId: string;
    idempotencyKey: string;
  }): Promise<{ hold: LoyaltyHoldView; idempotentReplay: boolean }>;
  releaseHold(params: {
    tenantId: string;
    actorId: string;
    holdId: string;
    reason: string;
    idempotencyKey: string;
  }): Promise<{ hold: LoyaltyHoldView; idempotentReplay: boolean }>;
  getHoldById(params: {
    tenantId: string;
    holdId: string;
  }): Promise<LoyaltyHoldView | null>;
}

@Injectable()
export class CustomerLoyaltyClient {
  private readonly logger = new Logger(CustomerLoyaltyClient.name);
  private delegate: CustomerLoyaltyDelegate | null = null;
  private simulateUnavailable = false;

  setDelegate(delegate: CustomerLoyaltyDelegate | null): void {
    this.delegate = delegate;
  }

  setSimulateUnavailable(unavailable: boolean): void {
    this.simulateUnavailable = unavailable;
  }

  async createHold(params: {
    actorId: string;
    customerId: string;
    orderId: string;
    checkoutId: string;
    points: number;
    idempotencyKey: string;
  }): Promise<{ hold: LoyaltyHoldView; idempotentReplay: boolean }> {
    const tenantId = TenantContext.require();
    if (this.simulateUnavailable) {
      throw new Error('CUSTOMER_LOYALTY_SERVICE_UNAVAILABLE');
    }
    if (this.delegate) {
      return this.delegate.createHold({ tenantId, ...params });
    }
    const baseUrl = process.env.CUSTOMER_URL;
    if (!baseUrl) {
      throw new Error('CUSTOMER_URL is not configured for loyalty hold');
    }
    const res = await fetch(`${baseUrl}/loyalty/holds`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tenant-id': tenantId,
        'idempotency-key': params.idempotencyKey,
      },
      body: JSON.stringify({
        customerId: params.customerId,
        orderId: params.orderId,
        checkoutId: params.checkoutId,
        points: params.points,
        idempotencyKey: params.idempotencyKey,
      }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(
        `Customer loyalty hold failed (${res.status}): ${errBody}`,
      );
    }
    return (await res.json()) as {
      hold: LoyaltyHoldView;
      idempotentReplay: boolean;
    };
  }

  async commitHold(params: {
    actorId: string;
    holdId: string;
    orderId: string;
    idempotencyKey: string;
  }): Promise<{ hold: LoyaltyHoldView; idempotentReplay: boolean }> {
    const tenantId = TenantContext.require();
    if (this.simulateUnavailable) {
      throw new Error('CUSTOMER_LOYALTY_SERVICE_UNAVAILABLE');
    }
    if (this.delegate) {
      return this.delegate.commitHold({ tenantId, ...params });
    }
    const baseUrl = process.env.CUSTOMER_URL;
    if (!baseUrl) {
      throw new Error('CUSTOMER_URL is not configured for loyalty commit');
    }
    const res = await fetch(
      `${baseUrl}/loyalty/holds/${encodeURIComponent(params.holdId)}/commit`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-tenant-id': tenantId,
          'idempotency-key': params.idempotencyKey,
        },
        body: JSON.stringify({
          orderId: params.orderId,
          idempotencyKey: params.idempotencyKey,
        }),
      },
    );
    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(
        `Customer loyalty commit failed (${res.status}): ${errBody}`,
      );
    }
    return (await res.json()) as {
      hold: LoyaltyHoldView;
      idempotentReplay: boolean;
    };
  }

  async releaseHold(params: {
    actorId: string;
    holdId: string;
    reason: string;
    idempotencyKey: string;
  }): Promise<{ hold: LoyaltyHoldView; idempotentReplay: boolean } | null> {
    const tenantId = TenantContext.require();
    if (this.simulateUnavailable) {
      return null;
    }
    if (this.delegate) {
      return this.delegate.releaseHold({ tenantId, ...params });
    }
    const baseUrl = process.env.CUSTOMER_URL;
    if (!baseUrl) {
      return null;
    }
    const res = await fetch(
      `${baseUrl}/loyalty/holds/${encodeURIComponent(params.holdId)}/release`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-tenant-id': tenantId,
          'idempotency-key': params.idempotencyKey,
        },
        body: JSON.stringify({
          reason: params.reason,
          idempotencyKey: params.idempotencyKey,
        }),
      },
    );
    if (!res.ok) {
      this.logger.warn(
        `Failed to release loyalty hold ${params.holdId}: ${res.status}`,
      );
      return null;
    }
    return (await res.json()) as {
      hold: LoyaltyHoldView;
      idempotentReplay: boolean;
    };
  }

  async getHoldById(holdId: string): Promise<LoyaltyHoldView | null> {
    const tenantId = TenantContext.require();
    if (this.simulateUnavailable) {
      return null;
    }
    if (this.delegate) {
      return this.delegate.getHoldById({ tenantId, holdId });
    }
    return null;
  }
}
