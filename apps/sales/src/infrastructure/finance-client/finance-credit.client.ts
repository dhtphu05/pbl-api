import { Injectable, Logger } from '@nestjs/common';
import { TenantContext } from '@pbl/common';

export interface CreditAuthorizationView {
  id: string;
  tenantId: string;
  customerId: string;
  branchId: string | null;
  orderId: string | null;
  checkoutId: string | null;
  amount: string;
  status: 'HELD' | 'COMMITTED' | 'RELEASED' | 'EXPIRED';
  idempotencyKey: string;
}

export interface FinanceCreditDelegate {
  authorizeCredit(params: {
    tenantId: string;
    actorId: string;
    idempotencyKey: string;
    customerId: string;
    branchId: string;
    orderId: string;
    checkoutId: string;
    amount: string;
  }): Promise<{
    status: 'APPROVED';
    authorization: CreditAuthorizationView;
    idempotentReplay: boolean;
  }>;
  commitAuthorization(params: {
    tenantId: string;
    actorId: string;
    authorizationId: string;
    idempotencyKey: string;
    orderId: string;
    orderCode: string;
    branchId: string;
  }): Promise<{
    status: 'COMMITTED';
    authorization: CreditAuthorizationView;
    idempotentReplay: boolean;
  }>;
  releaseAuthorization(params: {
    tenantId: string;
    actorId: string;
    authorizationId: string;
    reason: string;
  }): Promise<{
    status: 'RELEASED';
    authorization: CreditAuthorizationView;
    idempotentReplay: boolean;
  }>;
  getAuthorizationByIdempotencyKey(params: {
    tenantId: string;
    idempotencyKey: string;
  }): Promise<CreditAuthorizationView | null>;
}

@Injectable()
export class FinanceCreditClient {
  private readonly logger = new Logger(FinanceCreditClient.name);
  private delegate: FinanceCreditDelegate | null = null;
  private simulateUnavailable = false;

  setDelegate(delegate: FinanceCreditDelegate | null): void {
    this.delegate = delegate;
  }

  setSimulateUnavailable(unavailable: boolean): void {
    this.simulateUnavailable = unavailable;
  }

  async authorizeCredit(params: {
    actorId: string;
    idempotencyKey: string;
    customerId: string;
    branchId: string;
    orderId: string;
    checkoutId: string;
    amount: string;
  }): Promise<{
    status: 'APPROVED';
    authorization: CreditAuthorizationView;
    idempotentReplay: boolean;
  }> {
    const tenantId = TenantContext.require();
    if (this.simulateUnavailable) {
      const err = new Error('FINANCE_CREDIT_SERVICE_UNAVAILABLE');
      (err as { code?: string }).code = 'FINANCE_UNAVAILABLE';
      throw err;
    }
    if (this.delegate) {
      return this.delegate.authorizeCredit({ tenantId, ...params });
    }
    const baseUrl = process.env.FINANCE_URL;
    if (!baseUrl) {
      const err = new Error('FINANCE_URL is not configured for credit sale');
      (err as { code?: string }).code = 'FINANCE_UNAVAILABLE';
      throw err;
    }
    const res = await fetch(`${baseUrl}/credit-authorizations`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tenant-id': tenantId,
        'idempotency-key': params.idempotencyKey,
      },
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      const errBody = await res.text();
      const err = new Error(
        `Finance credit authorization failed (${res.status}): ${errBody}`,
      );
      (err as { status?: number }).status = res.status;
      throw err;
    }
    return (await res.json()) as {
      status: 'APPROVED';
      authorization: CreditAuthorizationView;
      idempotentReplay: boolean;
    };
  }

  async commitAuthorization(params: {
    actorId: string;
    authorizationId: string;
    idempotencyKey: string;
    orderId: string;
    orderCode: string;
    branchId: string;
  }): Promise<{
    status: 'COMMITTED';
    authorization: CreditAuthorizationView;
    idempotentReplay: boolean;
  }> {
    const tenantId = TenantContext.require();
    if (this.simulateUnavailable) {
      const err = new Error('FINANCE_CREDIT_SERVICE_UNAVAILABLE');
      (err as { code?: string }).code = 'FINANCE_UNAVAILABLE';
      throw err;
    }
    if (this.delegate) {
      return this.delegate.commitAuthorization({ tenantId, ...params });
    }
    const baseUrl = process.env.FINANCE_URL;
    if (!baseUrl) {
      const err = new Error('FINANCE_URL is not configured for credit commit');
      (err as { code?: string }).code = 'FINANCE_UNAVAILABLE';
      throw err;
    }
    const res = await fetch(
      `${baseUrl}/credit-authorizations/${encodeURIComponent(params.authorizationId)}/commit`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-tenant-id': tenantId,
          'idempotency-key': params.idempotencyKey,
        },
        body: JSON.stringify(params),
      },
    );
    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(
        `Finance credit commit failed (${res.status}): ${errBody}`,
      );
    }
    return (await res.json()) as {
      status: 'COMMITTED';
      authorization: CreditAuthorizationView;
      idempotentReplay: boolean;
    };
  }

  async releaseAuthorization(params: {
    actorId: string;
    authorizationId: string;
    reason: string;
  }): Promise<void> {
    const tenantId = TenantContext.require();
    if (this.simulateUnavailable) {
      return;
    }
    if (this.delegate) {
      await this.delegate.releaseAuthorization({ tenantId, ...params });
      return;
    }
    const baseUrl = process.env.FINANCE_URL;
    if (!baseUrl) {
      return;
    }
    try {
      await fetch(
        `${baseUrl}/credit-authorizations/${encodeURIComponent(params.authorizationId)}/release`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-tenant-id': tenantId,
          },
          body: JSON.stringify({ reason: params.reason }),
        },
      );
    } catch (err) {
      this.logger.warn(
        `Failed to release credit authorization ${params.authorizationId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async getAuthorizationByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<CreditAuthorizationView | null> {
    const tenantId = TenantContext.require();
    if (this.simulateUnavailable) {
      return null;
    }
    if (this.delegate) {
      return this.delegate.getAuthorizationByIdempotencyKey({
        tenantId,
        idempotencyKey,
      });
    }
    return null;
  }
}
