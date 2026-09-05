import type { SupportAdapter } from "@osas/adapter";
import { MockSupportAdapter, createDemoFixtures } from "@osas/mock-backend";

export function createSeededAdapter(): SupportAdapter {
  return new MockSupportAdapter(createDemoFixtures());
}

export function createEmptyAdapter(): SupportAdapter {
  return new MockSupportAdapter();
}
