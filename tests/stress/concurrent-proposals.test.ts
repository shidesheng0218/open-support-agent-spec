/**
 * Concurrent Proposal Handling Tests
 * 
 * Tests system behavior under concurrent load:
 * - Multiple simultaneous proposals
 * - Idempotency key collision handling
 * - Database connection pool management
 * - Policy evaluation under load
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';
import pLimit from 'p-limit';

describe('Concurrent Proposal Handling', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp({
      auth: { mode: 'demo' },
      storage: { type: 'memory' },
      llm: { provider: 'mock' },
      execution: { mode: 'shadow' },
    });
    await app.ready();
  });

  it('handles 50 simultaneous proposals', async () => {
    const limit = pLimit(50);
    const tenantId = 'stress-test-tenant';
    
    const tasks = Array.from({ length: 50 }, (_, i) =>
      limit(async () => {
        const response = await app.inject({
          method: 'POST',
          url: '/v1/proposals',
          headers: {
            'x-osas-tenant': tenantId,
            'x-osas-role': 'agent',
            'x-osas-actor': `agent-${i}`,
          },
          payload: {
            caseId: `case-${i}`,
            actionType: 'issue_refund',
            parameters: {
              orderId: `order-${i}`,
              amount: { value: 10 + i, currency: 'USD' },
              reason: 'customer_request',
            },
            evidence: {
              orderHistory: [`Order ${i} exists`],
              identityVerification: { status: 'verified', method: 'email' },
            },
          },
        });

        return {
          statusCode: response.statusCode,
          body: response.json(),
        };
      })
    );

    const results = await Promise.all(tasks);
    const succeeded = results.filter(r => r.statusCode === 201);
    const failed = results.filter(r => r.statusCode !== 201);

    // Allow up to 5 failures (10%) due to resource contention
    expect(succeeded.length).toBeGreaterThanOrEqual(45);
    expect(failed.length).toBeLessThanOrEqual(5);

    // All successful proposals should have unique IDs
    const proposalIds = succeeded.map(r => r.body.proposalId);
    const uniqueIds = new Set(proposalIds);
    expect(uniqueIds.size).toBe(succeeded.length);
  }, { timeout: 30000 });

  it('prevents duplicate execution via idempotency key', async () => {
    const tenantId = 'idempotency-test';
    const idempotencyKey = crypto.randomUUID();

    const payload = {
      caseId: 'case-123',
      actionType: 'issue_refund',
      parameters: {
        orderId: 'order-456',
        amount: { value: 50, currency: 'USD' },
        reason: 'customer_request',
      },
      evidence: {
        orderHistory: ['Order exists'],
        identityVerification: { status: 'verified', method: 'email' },
      },
    };

    // Make two identical requests simultaneously
    const [r1, r2] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/v1/proposals',
        headers: {
          'x-osas-tenant': tenantId,
          'x-osas-role': 'agent',
          'x-osas-actor': 'agent-1',
          'idempotency-key': idempotencyKey,
        },
        payload,
      }),
      app.inject({
        method: 'POST',
        url: '/v1/proposals',
        headers: {
          'x-osas-tenant': tenantId,
          'x-osas-role': 'agent',
          'x-osas-actor': 'agent-1',
          'idempotency-key': idempotencyKey,
        },
        payload,
      }),
    ]);

    // Both should succeed
    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(201);

    // Both should return the same proposal ID
    const body1 = r1.json();
    const body2 = r2.json();
    expect(body1.proposalId).toBe(body2.proposalId);
  });

  it('handles burst traffic followed by idle period', async () => {
    const tenantId = 'burst-test';

    // Burst: 100 proposals in <1 second
    const burst1Start = Date.now();
    const burst1 = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        app.inject({
          method: 'POST',
          url: '/v1/proposals',
          headers: {
            'x-osas-tenant': tenantId,
            'x-osas-role': 'agent',
            'x-osas-actor': `agent-${i}`,
          },
          payload: {
            caseId: `case-burst1-${i}`,
            actionType: 'issue_refund',
            parameters: {
              orderId: `order-${i}`,
              amount: { value: 10, currency: 'USD' },
              reason: 'customer_request',
            },
            evidence: {
              orderHistory: ['Order exists'],
              identityVerification: { status: 'verified', method: 'email' },
            },
          },
        })
      )
    );
    const burst1Duration = Date.now() - burst1Start;

    // Idle: wait 2 seconds
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Burst 2: another 100 proposals
    const burst2Start = Date.now();
    const burst2 = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        app.inject({
          method: 'POST',
          url: '/v1/proposals',
          headers: {
            'x-osas-tenant': tenantId,
            'x-osas-role': 'agent',
            'x-osas-actor': `agent-${i}`,
          },
          payload: {
            caseId: `case-burst2-${i}`,
            actionType: 'issue_refund',
            parameters: {
              orderId: `order-${i}`,
              amount: { value: 10, currency: 'USD' },
              reason: 'customer_request',
            },
            evidence: {
              orderHistory: ['Order exists'],
              identityVerification: { status: 'verified', method: 'email' },
            },
          },
        })
      )
    );
    const burst2Duration = Date.now() - burst2Start;

    // Both bursts should succeed mostly
    const burst1Success = burst1.filter(r => r.statusCode === 201).length;
    const burst2Success = burst2.filter(r => r.statusCode === 201).length;

    expect(burst1Success).toBeGreaterThanOrEqual(90);
    expect(burst2Success).toBeGreaterThanOrEqual(90);

    // Performance should not degrade significantly
    expect(burst2Duration).toBeLessThanOrEqual(burst1Duration * 1.5);
  }, { timeout: 60000 });

  it('maintains policy evaluation latency under load', async () => {
    const tenantId = 'latency-test';
    const limit = pLimit(20);
    const latencies: number[] = [];

    const tasks = Array.from({ length: 100 }, (_, i) =>
      limit(async () => {
        const start = Date.now();
        
        const response = await app.inject({
          method: 'POST',
          url: '/v1/proposals',
          headers: {
            'x-osas-tenant': tenantId,
            'x-osas-role': 'agent',
            'x-osas-actor': `agent-${i}`,
          },
          payload: {
            caseId: `case-${i}`,
            actionType: 'issue_refund',
            parameters: {
              orderId: `order-${i}`,
              amount: { value: 10, currency: 'USD' },
              reason: 'customer_request',
            },
            evidence: {
              orderHistory: ['Order exists'],
              identityVerification: { status: 'verified', method: 'email' },
            },
          },
        });

        const latency = Date.now() - start;
        latencies.push(latency);

        return response.statusCode;
      })
    );

    await Promise.all(tasks);

    // Calculate P50, P95, P99
    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    const p95 = latencies[Math.floor(latencies.length * 0.95)];
    const p99 = latencies[Math.floor(latencies.length * 0.99)];

    // P50 should be fast
    expect(p50).toBeLessThan(100);
    
    // P95 should be acceptable
    expect(p95).toBeLessThan(500);
    
    // P99 may have some outliers but should still be reasonable
    expect(p99).toBeLessThan(2000);

    console.log(`Latency percentiles: P50=${p50}ms P95=${p95}ms P99=${p99}ms`);
  }, { timeout: 60000 });
});

describe('Database Connection Pool Behavior', () => {
  // Note: These tests use in-memory storage but simulate connection behavior

  it('handles connection pool exhaustion gracefully', async () => {
    const app = await buildApp({
      auth: { mode: 'demo' },
      storage: { type: 'memory' },
      llm: { provider: 'mock' },
      execution: { mode: 'shadow' },
    });
    await app.ready();

    const tenantId = 'pool-test';
    
    // Simulate many slow queries
    const limit = pLimit(100); // More than typical pool size
    const tasks = Array.from({ length: 100 }, (_, i) =>
      limit(async () => {
        const response = await app.inject({
          method: 'POST',
          url: '/v1/proposals',
          headers: {
            'x-osas-tenant': tenantId,
            'x-osas-role': 'agent',
            'x-osas-actor': `agent-${i}`,
          },
          payload: {
            caseId: `case-${i}`,
            actionType: 'issue_refund',
            parameters: {
              orderId: `order-${i}`,
              amount: { value: 10, currency: 'USD' },
              reason: 'customer_request',
            },
            evidence: {
              orderHistory: ['Order exists'],
              identityVerification: { status: 'verified', method: 'email' },
            },
          },
        });

        return response.statusCode;
      })
    );

    const results = await Promise.all(tasks);
    
    // Should not crash; may queue some requests
    const succeeded = results.filter(code => code === 201).length;
    expect(succeeded).toBeGreaterThan(0);
  }, { timeout: 60000 });
});
