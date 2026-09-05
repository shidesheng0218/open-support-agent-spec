import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv/dist/2020.js";
import addFormatsCjs from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";
import {
  loadManifest,
  loadSchema,
  listSchemas,
  type SchemaManifest,
  type SchemaManifestEntry,
} from "./manifest.js";
import { resolveSchemasDir } from "./paths.js";

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export interface SchemaValidator {
  validate(schemaName: string, data: unknown): ValidationResult;
  loadManifest(): SchemaManifest;
  loadSchema(name: string): Record<string, unknown>;
  listSchemas(): SchemaManifestEntry[];
}

/**
 * Builds an Ajv 2020-12 validator with every schema in the manifest registered
 * (keyed by $id, so relative $refs between schemas resolve).
 */
export function createValidator(schemasDir: string = resolveSchemasDir()): SchemaValidator {
  const manifest = loadManifest(schemasDir);
  const schemasByName = new Map<string, Record<string, unknown>>();
  for (const entry of manifest.schemas) {
    schemasByName.set(entry.name, loadSchema(entry.name, schemasDir));
  }

  const ajv = new Ajv2020({ allErrors: true, strict: false });
  // ajv-formats is CJS (`module.exports = plugin`); under NodeNext the default
  // binding is typed as the namespace, so cast to the declared plugin type.
  const addFormats = addFormatsCjs as unknown as FormatsPlugin;
  addFormats(ajv);
  for (const schema of schemasByName.values()) {
    ajv.addSchema(schema);
  }

  return {
    validate(schemaName: string, data: unknown): ValidationResult {
      const schema = schemasByName.get(schemaName);
      if (!schema) {
        throw new Error(`Unknown schema: ${schemaName}`);
      }
      const id = schema.$id as string;
      const validateFn = (ajv.getSchema(id) ?? ajv.compile(schema)) as ValidateFunction;
      const valid = validateFn(data);
      const errors: ValidationError[] = (validateFn.errors ?? []).map((e) => ({
        path: e.instancePath ?? "",
        message: e.message ?? "invalid",
      }));
      return { valid, errors };
    },
    loadManifest: () => manifest,
    loadSchema: (name: string) => loadSchema(name, schemasDir),
    listSchemas: () => manifest.schemas,
  };
}

let singleton: SchemaValidator | undefined;

/** Lazily-initialized shared validator over the default schemas dir. */
export function getValidator(): SchemaValidator {
  singleton ??= createValidator();
  return singleton;
}

/** Convenience wrapper over the singleton. */
export function validate(schemaName: string, data: unknown): ValidationResult {
  return getValidator().validate(schemaName, data);
}
