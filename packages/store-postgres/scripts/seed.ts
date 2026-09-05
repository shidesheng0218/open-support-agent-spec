import { createPool, ensureTenant } from "../src/pool.js";
import { migrate } from "../src/migrate.js";

// pnpm db:seed — seeds the demo tenant (idempotent). Requires DATABASE_URL.
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set; seeding requires a PostgreSQL connection string.");
  process.exit(1);
}

const pool = createPool(url);
try {
  await migrate(pool);
  await ensureTenant(pool, process.env.OSAS_SEED_TENANT ?? "tenant_demo");
  console.log(`seeded tenant: ${process.env.OSAS_SEED_TENANT ?? "tenant_demo"}`);
} finally {
  await pool.end();
}
