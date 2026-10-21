/**
 * Production Preflight Checks
 * 
 * Enforces security and operational requirements before starting the API.
 * In production, fails closed: any violation terminates the process.
 */

interface PreflightCheck {
  name: string;
  severity: 'error' | 'warning';
  check: () => boolean;
  message: string;
}

export function runPreflightChecks(): void {
  const env = process.env;
  const isProduction = env.NODE_ENV === 'production';
  
  const checks: PreflightCheck[] = [
    // Authentication
    {
      name: 'auth-mode',
      severity: 'error',
      check: () => !isProduction || env.OSAS_AUTH_MODE === 'jwt',
      message: 'Production requires OSAS_AUTH_MODE=jwt (demo mode is forbidden)',
    },
    {
      name: 'jwt-config',
      severity: 'error',
      check: () => {
        if (env.OSAS_AUTH_MODE !== 'jwt') return true;
        return !!(env.OSAS_JWKS_URL && env.OSAS_JWT_ISSUER && env.OSAS_JWT_AUDIENCE);
      },
      message: 'JWT mode requires OSAS_JWKS_URL, OSAS_JWT_ISSUER, and OSAS_JWT_AUDIENCE',
    },
    
    // Storage
    {
      name: 'storage-mode',
      severity: 'error',
      check: () => !isProduction || env.OSAS_STORAGE === 'postgres',
      message: 'Production requires OSAS_STORAGE=postgres (memory storage is forbidden)',
    },
    {
      name: 'database-url',
      severity: 'error',
      check: () => {
        if (env.OSAS_STORAGE !== 'postgres') return true;
        return !!env.DATABASE_URL;
      },
      message: 'Postgres storage requires DATABASE_URL',
    },
    
    // Security
    {
      name: 'conformance-mode',
      severity: 'error',
      check: () => !isProduction || env.OSAS_CONFORMANCE_MODE !== 'true',
      message: 'Conformance mode is forbidden in production',
    },
    {
      name: 'execution-mode',
      severity: 'warning',
      check: () => env.OSAS_EXECUTION_MODE === 'shadow' || env.OSAS_EXECUTION_MODE === 'sandbox',
      message: 'Consider using shadow or sandbox mode unless live execution is explicitly required',
    },
    
    // LLM Cost Control
    {
      name: 'llm-budget',
      severity: 'warning',
      check: () => !!(env.OSAS_LLM_DAILY_BUDGET_USD && env.OSAS_LLM_CASE_BUDGET_USD),
      message: 'Recommended: set OSAS_LLM_DAILY_BUDGET_USD and OSAS_LLM_CASE_BUDGET_USD',
    },
    {
      name: 'llm-pricing',
      severity: 'warning',
      check: () => {
        if (env.OSAS_LLM_PROVIDER === 'mock') return true;
        const hasInput = !!env.OSAS_LLM_INPUT_USD_PER_MTOKEN;
        const hasOutput = !!env.OSAS_LLM_OUTPUT_USD_PER_MTOKEN;
        return (hasInput && hasOutput) || (!hasInput && !hasOutput);
      },
      message: 'Set BOTH OSAS_LLM_INPUT_USD_PER_MTOKEN and OSAS_LLM_OUTPUT_USD_PER_MTOKEN or neither',
    },
    
    // Webhook Security
    {
      name: 'governance-event-key',
      severity: 'warning',
      check: () => {
        if (!env.OSAS_GOVERNANCE_EVENT_KEY) return true; // disabled is OK
        return (env.OSAS_GOVERNANCE_EVENT_KEY?.length ?? 0) >= 32;
      },
      message: 'OSAS_GOVERNANCE_EVENT_KEY should be at least 32 characters',
    },
    {
      name: 'slack-signing-secret',
      severity: 'warning',
      check: () => {
        if (!env.SLACK_SIGNING_SECRET) return true; // disabled is OK
        return (env.SLACK_SIGNING_SECRET?.length ?? 0) >= 16;
      },
      message: 'SLACK_SIGNING_SECRET should be at least 16 characters',
    },
  ];
  
  const errors: PreflightCheck[] = [];
  const warnings: PreflightCheck[] = [];
  
  for (const check of checks) {
    if (!check.check()) {
      if (check.severity === 'error') {
        errors.push(check);
      } else {
        warnings.push(check);
      }
    }
  }
  
  // Report results
  if (warnings.length > 0) {
    console.warn('⚠️  Preflight warnings:');
    for (const w of warnings) {
      console.warn(`  - [${w.name}] ${w.message}`);
    }
  }
  
  if (errors.length > 0) {
    console.error('❌ Preflight checks failed:');
    for (const e of errors) {
      console.error(`  - [${e.name}] ${e.message}`);
    }
    
    if (isProduction) {
      console.error('\n🛑 Cannot start in production with failed checks. Exiting.');
      process.exit(1);
    } else {
      console.warn('\n⚠️  Would fail in production. Fix these issues before deploying.');
    }
  } else if (warnings.length === 0) {
    console.log('✅ All preflight checks passed');
  } else {
    console.log('✅ Preflight checks passed (with warnings)');
  }
}
