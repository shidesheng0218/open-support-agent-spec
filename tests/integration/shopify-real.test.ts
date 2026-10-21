/**
 * Real Shopify Integration Tests
 * 
 * These tests call real Shopify APIs and are skipped by default.
 * Enable with: SHOPIFY_TEST_MODE=1 pnpm test:integration
 * 
 * Required environment variables:
 * - SHOPIFY_SHOP_DOMAIN: Your test shop domain (e.g., test-shop.myshopify.com)
 * - SHOPIFY_ADMIN_ACCESS_TOKEN: Admin API access token with read_orders scope
 * - SHOPIFY_TEST_ORDER_ID: A real order ID in your test shop
 * - SHOPIFY_TEST_CUSTOMER_EMAIL: Email of a customer with orders
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createShopifyAdapter } from '@osas/shopify-adapter';
import type { SupportAdapter } from '@osas/core';

const skipIfNoShopify = process.env.SHOPIFY_TEST_MODE !== '1';

describe.skipIf(skipIfNoShopify)('Shopify Real Integration', () => {
  let adapter: SupportAdapter;
  
  beforeAll(() => {
    const required = [
      'SHOPIFY_SHOP_DOMAIN',
      'SHOPIFY_ADMIN_ACCESS_TOKEN',
      'SHOPIFY_TEST_ORDER_ID',
      'SHOPIFY_TEST_CUSTOMER_EMAIL',
    ];
    
    for (const key of required) {
      if (!process.env[key]) {
        throw new Error(`Missing required env var: ${key}`);
      }
    }
    
    adapter = createShopifyAdapter({
      shopDomain: process.env.SHOPIFY_SHOP_DOMAIN!,
      accessToken: process.env.SHOPIFY_ADMIN_ACCESS_TOKEN!,
      apiVersion: process.env.SHOPIFY_API_VERSION ?? '2025-01',
    });
  });

  it('fetches real order by ID', async () => {
    const orderId = process.env.SHOPIFY_TEST_ORDER_ID!;
    const ctx = {
      tenantId: 'test-tenant',
      principal: { role: 'agent' as const, actorId: 'test-agent' },
    };

    const order = await adapter.getOrder(ctx, orderId);

    expect(order).toBeDefined();
    expect(order.id).toBe(orderId);
    expect(order.customer).toBeDefined();
    expect(order.customer.email).toMatch(/^[^@]+@[^@]+\.[^@]+$/);
    expect(order.totalAmount.value).toBeGreaterThan(0);
    expect(['USD', 'EUR', 'GBP', 'CAD']).toContain(order.totalAmount.currency);
    expect(['pending', 'authorized', 'paid', 'refunded', 'voided']).toContain(order.status);
    expect(order.createdAt).toBeInstanceOf(Date);
  });

  it('searches orders by customer email', async () => {
    const email = process.env.SHOPIFY_TEST_CUSTOMER_EMAIL!;
    const ctx = {
      tenantId: 'test-tenant',
      principal: { role: 'agent' as const, actorId: 'test-agent' },
    };

    const orders = await adapter.searchOrders(ctx, {
      customerEmail: email,
      limit: 10,
    });

    expect(Array.isArray(orders)).toBe(true);
    expect(orders.length).toBeGreaterThan(0);
    expect(orders.length).toBeLessThanOrEqual(10);
    
    for (const order of orders) {
      expect(order.customer.email.toLowerCase()).toBe(email.toLowerCase());
    }
  });

  it('handles non-existent order gracefully', async () => {
    const ctx = {
      tenantId: 'test-tenant',
      principal: { role: 'agent' as const, actorId: 'test-agent' },
    };

    await expect(
      adapter.getOrder(ctx, 'nonexistent-order-id-12345')
    ).rejects.toThrow(/not found|404/i);
  });

  it('respects API rate limits', async () => {
    const ctx = {
      tenantId: 'test-tenant',
      principal: { role: 'agent' as const, actorId: 'test-agent' },
    };

    // Make 10 rapid requests
    const promises = Array.from({ length: 10 }, (_, i) =>
      adapter.searchOrders(ctx, {
        customerEmail: process.env.SHOPIFY_TEST_CUSTOMER_EMAIL!,
        limit: 1,
      })
    );

    // Should all succeed (adapter handles rate limiting internally)
    const results = await Promise.all(promises);
    expect(results).toHaveLength(10);
  }, { timeout: 30000 });

  it('validates shop domain and credentials', async () => {
    const invalidAdapter = createShopifyAdapter({
      shopDomain: 'invalid-shop-12345.myshopify.com',
      accessToken: 'invalid-token',
      apiVersion: '2025-01',
    });

    const ctx = {
      tenantId: 'test-tenant',
      principal: { role: 'agent' as const, actorId: 'test-agent' },
    };

    await expect(
      invalidAdapter.searchOrders(ctx, { limit: 1 })
    ).rejects.toThrow(/unauthorized|401|403/i);
  });
});

describe.skipIf(skipIfNoShopify)('Shopify Real Performance', () => {
  let adapter: SupportAdapter;
  
  beforeAll(() => {
    adapter = createShopifyAdapter({
      shopDomain: process.env.SHOPIFY_SHOP_DOMAIN!,
      accessToken: process.env.SHOPIFY_ADMIN_ACCESS_TOKEN!,
    });
  });

  it('completes order fetch within 2 seconds', async () => {
    const ctx = {
      tenantId: 'test-tenant',
      principal: { role: 'agent' as const, actorId: 'test-agent' },
    };

    const start = Date.now();
    await adapter.getOrder(ctx, process.env.SHOPIFY_TEST_ORDER_ID!);
    const duration = Date.now() - start;

    expect(duration).toBeLessThan(2000);
  });

  it('completes search within 3 seconds', async () => {
    const ctx = {
      tenantId: 'test-tenant',
      principal: { role: 'agent' as const, actorId: 'test-agent' },
    };

    const start = Date.now();
    await adapter.searchOrders(ctx, {
      customerEmail: process.env.SHOPIFY_TEST_CUSTOMER_EMAIL!,
      limit: 10,
    });
    const duration = Date.now() - start;

    expect(duration).toBeLessThan(3000);
  });
});
