import { createPool } from "../src/pool.js";
import { migrate } from "../src/migrate.js";

// pnpm db:reset — drops all OSAS tables and re-migrates. Development only.
if (process.env.NODE_ENV === "production") {
  console.error("db:reset refuses to run with NODE_ENV=production.");
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set; reset requires a PostgreSQL connection string.");
  process.exit(1);
}

const TABLES = [
  "model_usage",
  "shadow_runs",
  "execution_records",
  "audit_events",
  "evidence",
  "approvals",
  "proposals",
  "policy_versions",
  "tenants",
  "schema_migrations",
];

const pool = createPool(url);
try {
  await pool.query(`DROP TABLE IF EXISTS ${TABLES.join(", ")} CASCADE`);
  const ran = await migrate(pool);
  console.log(`reset complete; migrations applied: ${ran.join(", ")}`);
} finally {
  await pool.end();
}
