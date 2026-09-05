import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import type { SupportAdapter } from "@osas/adapter";
import { InMemoryExecutionStore } from "@osas/policy-engine";
import { ModelGateway, MockModelProvider } from "@osas/model-gateway";
import { createSeededAdapter } from "./seed.js";
import { loggerOptions, registerPlugins } from "./plugins.js";
import { registerRoutes } from "./routes/index.js";

export interface BuildAppOptions {
  adapter?: SupportAdapter;
  logger?: boolean;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const adapter = opts.adapter ?? createSeededAdapter();
  const app = Fastify({ logger: opts.logger === false ? false : loggerOptions });
  await app.register(cors, { origin: true });
  app.decorate("adapter", adapter);
  app.decorate("executionStore", new InMemoryExecutionStore());
  app.decorate("gateway", new ModelGateway([new MockModelProvider()]));
  registerPlugins(app);
  await registerRoutes(app);
  return app;
}
