import { createPool } from "../src/pool.js";
import { migrate } from "../src/migrate.js";

// pnpm db:migrate — applies pending migrations. Requires DATABASE_URL.
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set; migrations require a PostgreSQL connection string.");
  process.exit(1);
}

const pool = createPool(url);
try {
  const ran = await migrate(pool);
  console.log(ran.length === 0 ? "migrations: already up to date" : `migrations applied: ${ran.join(", ")}`);
} finally {
  await pool.end();
}
