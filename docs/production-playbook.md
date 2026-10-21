# OSAS Production Deployment Playbook

## Overview

This playbook guides you through deploying the OSAS reference implementation
from demo-grade to production-grade. The reference implementation ships with
safe defaults (in-memory storage, mock LLM, demo auth) that are **not suitable
for production**.

**Read this entire document before deploying.**

---

## Pre-deployment Checklist

### 1. Security Requirements ✅

- [ ] **Authentication**: Set `OSAS_AUTH_MODE=jwt` with valid JWKS endpoint
- [ ] **Storage**: Configure `OSAS_STORAGE=postgres` with connection pooling
- [ ] **Secrets**: Never commit `.env` files; use environment injection or secret managers
- [ ] **Dependencies**: Review `SECURITY.md` for known vulnerabilities and mitigations
- [ ] **Conformance mode**: Ensure `OSAS_CONFORMANCE_MODE` is unset (test-only)
- [ ] **Network**: Run behind a reverse proxy with TLS termination

### 2. Infrastructure Setup 🔧

#### PostgreSQL Database

```bash
# Create database and user
createdb osas
psql osas -c "CREATE USER osas WITH PASSWORD 'YOUR_SECURE_PASSWORD';"
psql osas -c "GRANT ALL PRIVILEGES ON DATABASE osas TO osas;"

# Run migrations
cd open-support-agent-spec
pnpm db:migrate

# Optional: seed with demo data (do NOT use in production)
# pnpm db:seed
```

#### Connection Pooling (Recommended)

Use PgBouncer to prevent connection exhaustion:

```ini
# /etc/pgbouncer/pgbouncer.ini
[databases]
osas = host=localhost port=5432 dbname=osas

[pgbouncer]
listen_addr = 127.0.0.1
listen_port = 6432
auth_type = md5
auth_file = /etc/pgbouncer/userlist.txt
pool_mode = transaction
max_client_conn = 1000
default_pool_size = 25
```

Update `DATABASE_URL` to point to PgBouncer: `postgres://osas:pass@localhost:6432/osas`

### 3. Environment Configuration 📝

Copy `.env.production.example` to `.env.production` and fill in all required values:

```bash
cp .env.production.example .env.production
# Edit .env.production with your actual values
# NEVER commit this file to git
```

**Critical variables:**

```bash
NODE_ENV=production

# Auth (REQUIRED)
OSAS_AUTH_MODE=jwt
OSAS_JWKS_URL=https://your-idp.auth0.com/.well-known/jwks.json
OSAS_JWT_ISSUER=https://your-idp.auth0.com/
OSAS_JWT_AUDIENCE=osas-api

# Storage (REQUIRED)
OSAS_STORAGE=postgres
DATABASE_URL=postgres://osas:PASSWORD@pgbouncer:6432/osas

# LLM (REQUIRED)
OSAS_LLM_PROVIDER=openai-compatible
OSAS_LLM_BASE_URL=https://api.openai.com/v1
OSAS_LLM_API_KEY=sk-YOUR_KEY_HERE
OSAS_LLM_MODEL_FAST=gpt-4o-mini
OSAS_LLM_MODEL_STANDARD=gpt-4o

# Pricing & Budgets (HIGHLY RECOMMENDED)
OSAS_LLM_INPUT_USD_PER_MTOKEN=0.15
OSAS_LLM_OUTPUT_USD_PER_MTOKEN=0.60
OSAS_LLM_DAILY_BUDGET_USD=100.00
OSAS_LLM_CASE_BUDGET_USD=5.00

# Execution mode (start with shadow)
OSAS_EXECUTION_MODE=shadow
```

### 4. Run Preflight Checks 🚦

The API will refuse to start in production if critical checks fail:

```bash
NODE_ENV=production node apps/api/dist/index.js
```

Expected output:
```
✅ All preflight checks passed
{"level":30,"msg":"security posture summary",...}
{"level":30,"msg":"Server listening at http://..."}
```

If you see `🛑 Cannot start in production`, fix the reported issues.

---

## Deployment Patterns

### Docker Deployment

```dockerfile
# Dockerfile.production
FROM node:20-alpine

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable pnpm && pnpm install --prod --frozen-lockfile

COPY apps/api/dist ./apps/api/dist
COPY packages/*/dist ./packages/*/dist

ENV NODE_ENV=production
EXPOSE 3001

CMD ["node", "apps/api/dist/index.js"]
```

```bash
docker build -f Dockerfile.production -t osas-api:latest .
docker run -d \
  --name osas-api \
  --env-file .env.production \
  -p 3001:3001 \
  osas-api:latest
```

### Kubernetes Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: osas-api
spec:
  replicas: 3
  selector:
    matchLabels:
      app: osas-api
  template:
    metadata:
      labels:
        app: osas-api
    spec:
      containers:
      - name: api
        image: osas-api:latest
        ports:
        - containerPort: 3001
        env:
        - name: NODE_ENV
          value: "production"
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: osas-secrets
              key: database-url
        - name: OSAS_LLM_API_KEY
          valueFrom:
            secretKeyRef:
              name: osas-secrets
              key: llm-api-key
        # ... other env vars from ConfigMap
        livenessProbe:
          httpGet:
            path: /health
            port: 3001
          initialDelaySeconds: 10
          periodSeconds: 30
        readinessProbe:
          httpGet:
            path: /health
            port: 3001
          initialDelaySeconds: 5
          periodSeconds: 10
```

### Systemd Service (Bare Metal)

```ini
# /etc/systemd/system/osas-api.service
[Unit]
Description=OSAS API
After=network.target postgresql.service

[Service]
Type=simple
User=osas
WorkingDirectory=/opt/osas
EnvironmentFile=/opt/osas/.env.production
ExecStart=/usr/bin/node apps/api/dist/index.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable osas-api
sudo systemctl start osas-api
sudo systemctl status osas-api
```

---

## Day 1 Operations

### Health Monitoring

```bash
# Health endpoint (should return 200)
curl http://localhost:3001/health

# Expected response:
{"status":"ok"}
```

### Metrics to Watch

The API exposes Prometheus metrics at `/metrics` (when implemented):

- `osas_proposals_total{outcome="blocked|approved|executed"}` - Proposal outcomes
- `osas_policy_eval_duration_ms` - Policy evaluation latency
- `osas_llm_cost_usd` - Cumulative LLM spend
- `osas_llm_tokens_total{model="fast|standard"}` - Token usage

Set up alerts:

```yaml
# prometheus-alerts.yml
groups:
  - name: osas
    rules:
      - alert: HighPolicyRejectionRate
        expr: |
          rate(osas_proposals_total{outcome="blocked"}[5m]) 
          / rate(osas_proposals_total[5m]) > 0.5
        for: 10m
        annotations:
          summary: "Tenant {{ $labels.tenant_id }} has >50% blocked proposals"
      
      - alert: LLMBudgetNearLimit
        expr: osas_llm_cost_usd > (osas_llm_daily_budget_usd * 0.9)
        annotations:
          summary: "Tenant {{ $labels.tenant_id }} at 90% of daily LLM budget"
```

### Log Monitoring

Logs are structured JSON. Key fields:

- `level`: 20=debug, 30=info, 40=warn, 50=error
- `tenantId`: Multi-tenant identifier
- `caseId`: Support case reference
- `proposalId`: Action proposal ID
- `outcome`: Policy decision result

**PII Redaction**: The following fields are automatically redacted:
- `req.headers.authorization`
- `*.email`
- `*.phone`
- `req.body` / `res.body` / `*.body`

Verify redaction is working:

```bash
# Should show "[redacted]" for sensitive fields
tail -f /var/log/osas-api/app.log | grep email
```

### Database Maintenance

```sql
-- Check audit event growth
SELECT COUNT(*), pg_size_pretty(pg_total_relation_size('audit_events')) 
FROM audit_events;

-- Archive old audit events (older than 90 days)
DELETE FROM audit_events 
WHERE created_at < NOW() - INTERVAL '90 days';

-- Vacuum to reclaim space
VACUUM ANALYZE audit_events;
```

---

## Incident Response

### High Rejection Rate

**Symptom**: Most proposals are being blocked by policy

**Investigation**:
1. Check current policy: `GET /v1/policies/{tenantId}`
2. Review recent blocked proposals:
   ```sql
   SELECT outcome, outcome_reason, created_at 
   FROM audit_events 
   WHERE outcome = 'blocked' 
   ORDER BY created_at DESC 
   LIMIT 100;
   ```
3. Common causes:
   - Identity verification failing
   - Amount thresholds too restrictive
   - Missing evidence in context

**Mitigation**:
- Temporarily lower thresholds if false positives
- Update policy via `POST /v1/policies/{tenantId}/drafts` → activate

### LLM Budget Exhausted

**Symptom**: `budget_exceeded` errors in logs

**Investigation**:
```bash
# Check current spend via API
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3001/v1/meta/budget
```

**Mitigation**:
1. Increase `OSAS_LLM_DAILY_BUDGET_USD` if legitimate traffic
2. Identify expensive cases:
   ```sql
   SELECT case_id, SUM(token_cost_usd) as cost
   FROM usage_records
   WHERE date = CURRENT_DATE
   GROUP BY case_id
   ORDER BY cost DESC
   LIMIT 10;
   ```
3. Block abusive tenants if under attack

### Database Connection Pool Exhausted

**Symptom**: `ECONNREFUSED` or connection timeout errors

**Investigation**:
```sql
-- Check active connections
SELECT count(*) FROM pg_stat_activity WHERE datname='osas';

-- Check waiting queries
SELECT pid, usename, state, wait_event, query 
FROM pg_stat_activity 
WHERE wait_event IS NOT NULL;
```

**Mitigation**:
- Increase PgBouncer `default_pool_size`
- Scale API horizontally (more replicas)
- Investigate slow queries with `pg_stat_statements`

---

## Rollback Procedure

If issues arise post-deployment:

1. **Immediate**: Route traffic back to previous version via load balancer
2. **Database**: Migrations are forward-only; coordinate rollback schema changes
3. **Policy**: Revert to previous policy version via `PATCH /v1/policies/{tenantId}/activate`
4. **Logs**: Capture logs from failed deployment for post-mortem

---

## Security Hardening

### Rate Limiting

Add Nginx rate limiting in front of the API:

```nginx
http {
  limit_req_zone $binary_remote_addr zone=osas_api:10m rate=10r/s;
  
  server {
    location / {
      limit_req zone=osas_api burst=20 nodelay;
      proxy_pass http://localhost:3001;
    }
  }
}
```

### TLS Configuration

```nginx
server {
  listen 443 ssl http2;
  server_name api.osas.example.com;
  
  ssl_certificate /etc/letsencrypt/live/api.osas.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/api.osas.example.com/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_ciphers HIGH:!aNULL:!MD5;
  
  location / {
    proxy_pass http://localhost:3001;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

### Firewall Rules

```bash
# Allow only reverse proxy to reach API
sudo ufw allow from 10.0.0.0/8 to any port 3001
sudo ufw deny 3001
```

---

## Backup and Recovery

### Database Backups

```bash
# Daily backup via cron
0 2 * * * pg_dump osas | gzip > /backups/osas-$(date +\%Y\%m\%d).sql.gz

# Point-in-time recovery (if WAL archiving enabled)
# See PostgreSQL documentation
```

### Restore Procedure

```bash
# Stop API
sudo systemctl stop osas-api

# Restore database
gunzip < /backups/osas-20241021.sql.gz | psql osas

# Start API
sudo systemctl start osas-api
```

---

## Next Steps

- [ ] Set up monitoring dashboard (Grafana + Prometheus)
- [ ] Configure log aggregation (ELK/Loki)
- [ ] Enable audit log archival to S3/GCS
- [ ] Schedule security audit (recommended before v1.0)
- [ ] Plan chaos engineering tests (network partitions, DB failures)

---

## Support

- **Specification**: See `docs/spec-v0.2.md`
- **Security**: Report via GitHub Security tab
- **Community**: GitHub Discussions
- **Production hardening**: `docs/production-hardening.md`

**Remember**: The reference implementation is demo-grade. Production deployments
require hardening, monitoring, and ongoing maintenance. Plan accordingly.
