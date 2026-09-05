import type { FastifyInstance } from "fastify";
import { basicRoutes } from "./basic.js";
import { proposalRoutes } from "./proposals.js";
import { approvalRoutes } from "./approvals.js";
import { handoffRoutes } from "./handoffs.js";
import { chatRoutes } from "./chat.js";
import { policyRoutes } from "./policies.js";
import { usageRoutes } from "./usage.js";
import { shadowRoutes } from "./shadow.js";

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(basicRoutes);
  await app.register(proposalRoutes);
  await app.register(approvalRoutes);
  await app.register(handoffRoutes);
  await app.register(chatRoutes);
  await app.register(policyRoutes);
  await app.register(usageRoutes);
  await app.register(shadowRoutes);
}
