import { describe, expect, test } from "vitest";
import { ReportCollector, runCase } from "./report.js";
import {
  clone,
  ensureMoneyAt,
  findEnumPaths,
  findMoneyPaths,
  getManifest,
  loadFixture,
  loadSchema,
  setAtPath,
  validateAgainst,
  withoutKey,
  fixtureKey,
  type ManifestEntry,
} from "./helpers.js";

const SUITE = "schema-core";

type JsonObject = Record<string, unknown>;

function isDataObjectSchema(schema: JsonObject): boolean {
  return schema.type === "object" && typeof schema.properties === "object";
}

function registerSchemaCases(collector: ReportCollector, entry: ManifestEntry): void {
  const name = entry.name;
  const schema = loadSchema(entry);

  if (!isDataObjectSchema(schema)) {
    test(`${name}: manifest entry loads as parseable JSON Schema`, () =>
      runCase(collector, SUITE, `${name}: loads`, () => {
        expect(schema).toBeTypeOf("object");
      }));
    return;
  }

  test(`${name}: valid fixture passes`, () =>
    runCase(collector, SUITE, `${name}: valid fixture passes`, () => {
      const fixture = loadFixture(name);
      if (!fixture) throw new Error(`missing valid fixture fixtures/valid/${fixtureKey(name)}.json`);
      expect(validateAgainst(name, fixture)).toBe(true);
    }));

  const fixture = loadFixture(name);
  if (!fixture) {
    test(`${name}: fixture present`, () =>
      runCase(collector, SUITE, `${name}: fixture present`, () => {
        throw new Error(`missing valid fixture fixtures/valid/${fixtureKey(name)}.json`);
      }));
    return;
  }

  if (schema.additionalProperties === false) {
    test(`${name}: unknown additional property rejected`, () =>
      runCase(collector, SUITE, `${name}: unknown additional property rejected`, () => {
        const bad = { ...clone(fixture), __unknown_field__: true };
        expect(validateAgainst(name, bad)).toBe(false);
      }));
  }

  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  if (required.length > 0) {
    const field = required[0] as string;
    test(`${name}: missing required field '${field}' rejected`, () =>
      runCase(collector, SUITE, `${name}: missing required '${field}' rejected`, () => {
        expect(validateAgainst(name, withoutKey(fixture, field))).toBe(false);
      }));
  }

  if ("specVersion" in fixture) {
    test(`${name}: specVersion "0.2" rejected`, () =>
      runCase(collector, SUITE, `${name}: specVersion "0.2" rejected`, () => {
        const bad = { ...clone(fixture), specVersion: "0.2" };
        expect(validateAgainst(name, bad)).toBe(false);
      }));
  }

  const enumPath = findEnumPaths(schema)[0];
  if (enumPath) {
    test(`${name}: enum violation at '${enumPath}' rejected`, () =>
      runCase(collector, SUITE, `${name}: enum violation at '${enumPath}' rejected`, () => {
        const bad = clone(fixture);
        setAtPath(bad, enumPath, "ZZZ_NOT_A_VALID_ENUM");
        expect(validateAgainst(name, bad)).toBe(false);
      }));
  }

  const moneyPath = findMoneyPaths(schema)[0];
  if (moneyPath) {
    test(`${name}: money minorUnits float at '${moneyPath}' rejected`, () =>
      runCase(
        collector,
        SUITE,
        `${name}: money minorUnits float at '${moneyPath}' rejected`,
        () => {
          const bad = clone(fixture);
          ensureMoneyAt(bad, moneyPath);
          setAtPath(bad, `${moneyPath}.minorUnits`, 1.5);
          expect(validateAgainst(name, bad)).toBe(false);
        },
      ));
  }
}

export function registerSchemaCore(collector: ReportCollector): void {
  describe(SUITE, () => {
    const manifest = getManifest();

    test("manifest specVersion is 0.1", () =>
      runCase(collector, SUITE, "manifest specVersion is 0.1", () => {
        expect(manifest.specVersion).toBe("0.1");
      }));

    test("manifest lists at least the 8 core objects", () =>
      runCase(collector, SUITE, "manifest lists >= 8 core schemas", () => {
        const core = manifest.schemas.filter((s) => (s.profile ?? "core") === "core");
        expect(core.length).toBeGreaterThanOrEqual(8);
      }));

    for (const entry of manifest.schemas) {
      registerSchemaCases(collector, entry);
    }
  });
}
