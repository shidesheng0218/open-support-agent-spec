import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const workflowPath = resolve(import.meta.dirname, '../.github/workflows/ci.yml');
const workflow = readFileSync(workflowPath, 'utf8');
const buildTestJob = workflow.match(/  build-test:\n([\s\S]*?)(?=\n  [a-z][a-z-]*:\n|$)/)?.[1];

if (!buildTestJob) {
  throw new Error('CI workflow is missing the build-test job.');
}

const testIndex = buildTestJob.indexOf('- run: pnpm test\n');
const typecheckIndex = buildTestJob.indexOf('- run: pnpm typecheck\n');

if (testIndex === -1 || typecheckIndex === -1) {
  throw new Error('CI build-test job must run both pnpm test and pnpm typecheck.');
}

if (testIndex > typecheckIndex) {
  throw new Error(
    'CI must run pnpm test before pnpm typecheck because pnpm test builds workspace type declarations.',
  );
}
