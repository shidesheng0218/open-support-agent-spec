#!/usr/bin/env bash
# Production Readiness Check Script
# Run this before deploying to production

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

ERRORS=0
WARNINGS=0

echo "🔍 OSAS Production Readiness Check"
echo "===================================="
echo ""

# Check 1: Environment file exists
echo -n "✓ Checking .env.production exists... "
if [ -f .env.production ]; then
  echo -e "${GREEN}OK${NC}"
  source .env.production
else
  echo -e "${RED}FAIL${NC}"
  echo "  Create .env.production from .env.production.example"
  ERRORS=$((ERRORS + 1))
fi

# Check 2: NODE_ENV
echo -n "✓ Checking NODE_ENV=production... "
if [ "$NODE_ENV" = "production" ]; then
  echo -e "${GREEN}OK${NC}"
else
  echo -e "${YELLOW}WARNING${NC}"
  echo "  Set NODE_ENV=production in .env.production"
  WARNINGS=$((WARNINGS + 1))
fi

# Check 3: Auth mode
echo -n "✓ Checking OSAS_AUTH_MODE=jwt... "
if [ "$OSAS_AUTH_MODE" = "jwt" ]; then
  echo -e "${GREEN}OK${NC}"
else
  echo -e "${RED}FAIL${NC}"
  echo "  Production requires OSAS_AUTH_MODE=jwt (current: $OSAS_AUTH_MODE)"
  ERRORS=$((ERRORS + 1))
fi

# Check 4: JWT configuration
if [ "$OSAS_AUTH_MODE" = "jwt" ]; then
  echo -n "✓ Checking JWT configuration... "
  if [ -n "$OSAS_JWKS_URL" ] && [ -n "$OSAS_JWT_ISSUER" ] && [ -n "$OSAS_JWT_AUDIENCE" ]; then
    echo -e "${GREEN}OK${NC}"
  else
    echo -e "${RED}FAIL${NC}"
    echo "  JWT mode requires OSAS_JWKS_URL, OSAS_JWT_ISSUER, and OSAS_JWT_AUDIENCE"
    ERRORS=$((ERRORS + 1))
  fi
fi

# Check 5: Storage mode
echo -n "✓ Checking OSAS_STORAGE=postgres... "
if [ "$OSAS_STORAGE" = "postgres" ]; then
  echo -e "${GREEN}OK${NC}"
else
  echo -e "${RED}FAIL${NC}"
  echo "  Production requires OSAS_STORAGE=postgres (current: $OSAS_STORAGE)"
  ERRORS=$((ERRORS + 1))
fi

# Check 6: Database URL
if [ "$OSAS_STORAGE" = "postgres" ]; then
  echo -n "✓ Checking DATABASE_URL... "
  if [ -n "$DATABASE_URL" ]; then
    echo -e "${GREEN}OK${NC}"
    
    # Try to connect
    echo -n "✓ Testing database connection... "
    if command -v psql &> /dev/null; then
      if psql "$DATABASE_URL" -c "SELECT 1" &> /dev/null; then
        echo -e "${GREEN}OK${NC}"
      else
        echo -e "${RED}FAIL${NC}"
        echo "  Cannot connect to database. Check credentials and network."
        ERRORS=$((ERRORS + 1))
      fi
    else
      echo -e "${YELLOW}SKIP${NC} (psql not installed)"
      WARNINGS=$((WARNINGS + 1))
    fi
  else
    echo -e "${RED}FAIL${NC}"
    echo "  Postgres storage requires DATABASE_URL"
    ERRORS=$((ERRORS + 1))
  fi
fi

# Check 7: LLM Provider
echo -n "✓ Checking LLM provider configured... "
if [ "$OSAS_LLM_PROVIDER" = "mock" ]; then
  echo -e "${YELLOW}WARNING${NC}"
  echo "  Mock LLM provider is for testing only"
  WARNINGS=$((WARNINGS + 1))
elif [ -n "$OSAS_LLM_PROVIDER" ] && [ -n "$OSAS_LLM_API_KEY" ]; then
  echo -e "${GREEN}OK${NC}"
else
  echo -e "${RED}FAIL${NC}"
  echo "  Configure OSAS_LLM_PROVIDER and OSAS_LLM_API_KEY"
  ERRORS=$((ERRORS + 1))
fi

# Check 8: LLM Budgets
echo -n "✓ Checking LLM budgets configured... "
if [ -n "$OSAS_LLM_DAILY_BUDGET_USD" ] && [ -n "$OSAS_LLM_CASE_BUDGET_USD" ]; then
  echo -e "${GREEN}OK${NC}"
else
  echo -e "${YELLOW}WARNING${NC}"
  echo "  Recommended: set OSAS_LLM_DAILY_BUDGET_USD and OSAS_LLM_CASE_BUDGET_USD"
  WARNINGS=$((WARNINGS + 1))
fi

# Check 9: LLM Pricing
echo -n "✓ Checking LLM pricing configured... "
if [ -n "$OSAS_LLM_INPUT_USD_PER_MTOKEN" ] && [ -n "$OSAS_LLM_OUTPUT_USD_PER_MTOKEN" ]; then
  echo -e "${GREEN}OK${NC}"
elif [ -z "$OSAS_LLM_INPUT_USD_PER_MTOKEN" ] && [ -z "$OSAS_LLM_OUTPUT_USD_PER_MTOKEN" ]; then
  echo -e "${YELLOW}WARNING${NC}"
  echo "  Cost tracking disabled (pricing not set)"
  WARNINGS=$((WARNINGS + 1))
else
  echo -e "${RED}FAIL${NC}"
  echo "  Set BOTH OSAS_LLM_INPUT_USD_PER_MTOKEN and OSAS_LLM_OUTPUT_USD_PER_MTOKEN or neither"
  ERRORS=$((ERRORS + 1))
fi

# Check 10: Conformance mode
echo -n "✓ Checking conformance mode disabled... "
if [ "$OSAS_CONFORMANCE_MODE" = "true" ]; then
  echo -e "${RED}FAIL${NC}"
  echo "  Conformance mode is forbidden in production"
  ERRORS=$((ERRORS + 1))
else
  echo -e "${GREEN}OK${NC}"
fi

# Check 11: Execution mode
echo -n "✓ Checking execution mode... "
if [ "$OSAS_EXECUTION_MODE" = "shadow" ] || [ "$OSAS_EXECUTION_MODE" = "sandbox" ]; then
  echo -e "${GREEN}OK${NC} ($OSAS_EXECUTION_MODE)"
else
  echo -e "${YELLOW}WARNING${NC}"
  echo "  Consider using shadow or sandbox mode (current: $OSAS_EXECUTION_MODE)"
  WARNINGS=$((WARNINGS + 1))
fi

# Check 12: Webhook secrets
echo -n "✓ Checking webhook secret lengths... "
WEBHOOK_ERRORS=0
if [ -n "$OSAS_GOVERNANCE_EVENT_KEY" ]; then
  if [ ${#OSAS_GOVERNANCE_EVENT_KEY} -lt 32 ]; then
    echo -e "${YELLOW}WARNING${NC}"
    echo "  OSAS_GOVERNANCE_EVENT_KEY should be at least 32 characters"
    WARNINGS=$((WARNINGS + 1))
    WEBHOOK_ERRORS=1
  fi
fi
if [ -n "$SLACK_SIGNING_SECRET" ]; then
  if [ ${#SLACK_SIGNING_SECRET} -lt 16 ]; then
    echo -e "${YELLOW}WARNING${NC}"
    echo "  SLACK_SIGNING_SECRET should be at least 16 characters"
    WARNINGS=$((WARNINGS + 1))
    WEBHOOK_ERRORS=1
  fi
fi
if [ $WEBHOOK_ERRORS -eq 0 ]; then
  echo -e "${GREEN}OK${NC}"
fi

# Check 13: Build artifacts exist
echo -n "✓ Checking build artifacts... "
if [ -f apps/api/dist/index.js ]; then
  echo -e "${GREEN}OK${NC}"
else
  echo -e "${RED}FAIL${NC}"
  echo "  Run 'pnpm build' first"
  ERRORS=$((ERRORS + 1))
fi

# Check 14: Dependencies installed
echo -n "✓ Checking dependencies... "
if [ -d node_modules ]; then
  echo -e "${GREEN}OK${NC}"
else
  echo -e "${RED}FAIL${NC}"
  echo "  Run 'pnpm install' first"
  ERRORS=$((ERRORS + 1))
fi

# Check 15: TypeScript compilation
echo -n "✓ Checking TypeScript compilation... "
if command -v pnpm &> /dev/null; then
  if pnpm typecheck &> /dev/null; then
    echo -e "${GREEN}OK${NC}"
  else
    echo -e "${RED}FAIL${NC}"
    echo "  TypeScript errors found. Run 'pnpm typecheck'"
    ERRORS=$((ERRORS + 1))
  fi
else
  echo -e "${YELLOW}SKIP${NC} (pnpm not installed)"
  WARNINGS=$((WARNINGS + 1))
fi

# Check 16: Security audit
echo -n "✓ Checking security vulnerabilities... "
if command -v pnpm &> /dev/null; then
  AUDIT_OUTPUT=$(pnpm audit --json 2>/dev/null || echo '{}')
  CRITICAL=$(echo "$AUDIT_OUTPUT" | jq -r '.metadata.vulnerabilities.critical // 0' 2>/dev/null || echo 0)
  HIGH=$(echo "$AUDIT_OUTPUT" | jq -r '.metadata.vulnerabilities.high // 0' 2>/dev/null || echo 0)
  
  if [ "$CRITICAL" -gt 0 ] || [ "$HIGH" -gt 0 ]; then
    echo -e "${YELLOW}WARNING${NC}"
    echo "  Found $CRITICAL critical and $HIGH high vulnerabilities"
    echo "  See SECURITY.md for known issues and mitigations"
    WARNINGS=$((WARNINGS + 1))
  else
    echo -e "${GREEN}OK${NC}"
  fi
else
  echo -e "${YELLOW}SKIP${NC}"
  WARNINGS=$((WARNINGS + 1))
fi

echo ""
echo "===================================="
echo "Summary:"
echo "  Errors: $ERRORS"
echo "  Warnings: $WARNINGS"
echo ""

if [ $ERRORS -gt 0 ]; then
  echo -e "${RED}❌ Production readiness check FAILED${NC}"
  echo "Fix the errors above before deploying."
  exit 1
elif [ $WARNINGS -gt 0 ]; then
  echo -e "${YELLOW}⚠️  Production readiness check PASSED with warnings${NC}"
  echo "Review warnings above and proceed with caution."
  exit 0
else
  echo -e "${GREEN}✅ Production readiness check PASSED${NC}"
  echo "System is ready for production deployment."
  exit 0
fi
