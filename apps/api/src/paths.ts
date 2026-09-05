import path from "node:path";
import { fileURLToPath } from "node:url";

// apps/api/src (or apps/api/dist) -> repo root is three levels up.
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
