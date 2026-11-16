-- OSAS Support Domain Tables (补充 0001_init.sql 缺失的业务对象表)
-- 这些表让 Postgres SupportAdapter 可以持久化所有核心领域对象

-- Cases (工单)
CREATE TABLE IF NOT EXISTS cases (
  tenant_id   text        NOT NULL REFERENCES tenants (tenant_id),
  case_id     text        NOT NULL,
  customer_id text        NOT NULL,
  status      text        NOT NULL,
  profile     text        NOT NULL,
  subject     text,
  payload     jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, case_id)
);

CREATE INDEX IF NOT EXISTS cases_customer_idx ON cases (tenant_id, customer_id);
CREATE INDEX IF NOT EXISTS cases_status_idx ON cases (tenant_id, status);

-- Customers (客户)
CREATE TABLE IF NOT EXISTS customers (
  tenant_id   text        NOT NULL REFERENCES tenants (tenant_id),
  customer_id text        NOT NULL,
  email       text,
  region      text,
  identity    text,
  payload     jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, customer_id)
);

CREATE INDEX IF NOT EXISTS customers_email_idx ON customers (tenant_id, email) WHERE email IS NOT NULL;

-- Human Handoffs (接管)
CREATE TABLE IF NOT EXISTS handoffs (
  tenant_id   text        NOT NULL REFERENCES tenants (tenant_id),
  handoff_id  text        NOT NULL,
  case_id     text        NOT NULL,
  proposal_id text,
  status      text        NOT NULL,
  reason      text        NOT NULL,
  payload     jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, handoff_id)
);

CREATE INDEX IF NOT EXISTS handoffs_case_idx ON handoffs (tenant_id, case_id);
CREATE INDEX IF NOT EXISTS handoffs_status_idx ON handoffs (tenant_id, status);

-- Case Notes (工单备注)
CREATE TABLE IF NOT EXISTS case_notes (
  tenant_id text        NOT NULL REFERENCES tenants (tenant_id),
  note_id   text        NOT NULL,
  case_id   text        NOT NULL,
  payload   jsonb       NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, note_id)
);

CREATE INDEX IF NOT EXISTS case_notes_case_idx ON case_notes (tenant_id, case_id);

-- Escalations (升级)
CREATE TABLE IF NOT EXISTS escalations (
  tenant_id     text        NOT NULL REFERENCES tenants (tenant_id),
  escalation_id text        NOT NULL,
  case_id       text        NOT NULL,
  reason        text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, escalation_id)
);

CREATE INDEX IF NOT EXISTS escalations_case_idx ON escalations (tenant_id, case_id);

-- Orders (订单 - 演示用，真实系统应从 Shopify/Stripe 等读取)
CREATE TABLE IF NOT EXISTS orders (
  tenant_id   text        NOT NULL REFERENCES tenants (tenant_id),
  order_id    text        NOT NULL,
  customer_id text        NOT NULL,
  status      text        NOT NULL,
  payload     jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, order_id)
);

CREATE INDEX IF NOT EXISTS orders_customer_idx ON orders (tenant_id, customer_id);

-- Shipments (物流)
CREATE TABLE IF NOT EXISTS shipments (
  tenant_id   text        NOT NULL REFERENCES tenants (tenant_id),
  shipment_id text        NOT NULL,
  order_id    text        NOT NULL,
  status      text        NOT NULL,
  payload     jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, shipment_id)
);

CREATE INDEX IF NOT EXISTS shipments_order_idx ON shipments (tenant_id, order_id);

-- Shipment Incidents (物流事件)
CREATE TABLE IF NOT EXISTS shipment_incidents (
  tenant_id   text        NOT NULL REFERENCES tenants (tenant_id),
  incident_id text        NOT NULL,
  shipment_id text        NOT NULL,
  payload     jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, incident_id)
);

-- Refund Transactions (退款记录)
CREATE TABLE IF NOT EXISTS refund_transactions (
  tenant_id      text        NOT NULL REFERENCES tenants (tenant_id),
  transaction_id text        NOT NULL,
  order_id       text        NOT NULL,
  status         text        NOT NULL,
  payload        jsonb       NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, transaction_id)
);

CREATE INDEX IF NOT EXISTS refund_transactions_order_idx ON refund_transactions (tenant_id, order_id);

-- Item Claims (商品索赔)
CREATE TABLE IF NOT EXISTS item_claims (
  tenant_id  text        NOT NULL REFERENCES tenants (tenant_id),
  claim_id   text        NOT NULL,
  order_id   text        NOT NULL,
  line_id    text        NOT NULL,
  claim_type text        NOT NULL,
  status     text        NOT NULL,
  payload    jsonb       NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, claim_id)
);

CREATE INDEX IF NOT EXISTS item_claims_order_idx ON item_claims (tenant_id, order_id);

-- Exchange Requests (换货请求)
CREATE TABLE IF NOT EXISTS exchange_requests (
  tenant_id   text        NOT NULL REFERENCES tenants (tenant_id),
  request_id  text        NOT NULL,
  order_id    text        NOT NULL,
  status      text        NOT NULL,
  payload     jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, request_id)
);

-- Subscriptions (订阅)
CREATE TABLE IF NOT EXISTS subscriptions (
  tenant_id       text        NOT NULL REFERENCES tenants (tenant_id),
  subscription_id text        NOT NULL,
  customer_id     text        NOT NULL,
  status          text        NOT NULL,
  payload         jsonb       NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, subscription_id)
);

CREATE INDEX IF NOT EXISTS subscriptions_customer_idx ON subscriptions (tenant_id, customer_id);

-- Invoices (账单)
CREATE TABLE IF NOT EXISTS invoices (
  tenant_id   text        NOT NULL REFERENCES tenants (tenant_id),
  invoice_id  text        NOT NULL,
  customer_id text        NOT NULL,
  status      text        NOT NULL,
  payload     jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, invoice_id)
);

CREATE INDEX IF NOT EXISTS invoices_customer_idx ON invoices (tenant_id, customer_id);

-- Credit Balances (额度余额)
CREATE TABLE IF NOT EXISTS credit_balances (
  tenant_id   text        NOT NULL REFERENCES tenants (tenant_id),
  balance_id  text        NOT NULL,
  customer_id text        NOT NULL,
  payload     jsonb       NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, balance_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS credit_balances_customer_uq ON credit_balances (tenant_id, customer_id);

-- Knowledge Articles (知识库)
CREATE TABLE IF NOT EXISTS knowledge_articles (
  tenant_id  text        NOT NULL REFERENCES tenants (tenant_id),
  article_id text        NOT NULL,
  title      text        NOT NULL,
  tags       text[],
  payload    jsonb       NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, article_id)
);

CREATE INDEX IF NOT EXISTS knowledge_articles_tags_idx ON knowledge_articles USING GIN (tags);

-- Tenant Policies (租户策略 - 当前版本)
-- 注意：policy_versions 表已在 0001_init.sql 定义，这里只是加一个快速查询当前策略的视图
CREATE OR REPLACE VIEW active_policies AS
  SELECT DISTINCT ON (tenant_id)
    tenant_id,
    version,
    policy,
    activated_at
  FROM policy_versions
  WHERE status = 'active'
  ORDER BY tenant_id, activated_at DESC;
