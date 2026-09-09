import type { SupportAdapter } from "@osas/adapter";
import { MockSupportAdapter, SandboxSupportAdapter, createDemoFixtures } from "@osas/mock-backend";

export function createSeededAdapter(): SupportAdapter {
  return new MockSupportAdapter(createDemoFixtures());
}

export function createEmptyAdapter(): SupportAdapter {
  return new MockSupportAdapter();
}

export function createSandboxAdapter(): SupportAdapter {
  return new SandboxSupportAdapter(createDemoFixtures());
}
