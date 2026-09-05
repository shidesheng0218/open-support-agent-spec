import { buildApp } from "./app.js";
import { createEmptyAdapter, createSeededAdapter } from "./seed.js";

const port = Number(process.env.PORT ?? 3001);
const adapter = process.env.SEED_DEMO !== "false" ? createSeededAdapter() : createEmptyAdapter();

const app = await buildApp({ adapter });

try {
  await app.listen({ port, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
