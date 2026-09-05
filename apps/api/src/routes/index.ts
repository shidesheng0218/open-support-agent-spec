import type { FastifyInstance } from "fastify";
import { basicRoutes } from "./basic.js";
import { proposalRoutes } from "./proposals.js";
import { approvalRoutes } from "./approvals.js";
import { handoffRoutes } from "./handoffs.js";
import { chatRoutes } from "./chat.js";

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(basicRoutes);
  await app.register(proposalRoutes);
  await app.register(approvalRoutes);
  await app.register(handoffRoutes);
  await app.register(chatRoutes);
}
