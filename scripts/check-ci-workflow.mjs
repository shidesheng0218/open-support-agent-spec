import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const workflowPath = resolve(import.meta.dirname, '../.github/workflows/ci.yml');
const workflow = readFileSync(workflowPath, 'utf8');

function getJob(name) {
  const job = workflow.match(new RegExp(`  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z][a-z-]*:\\n|$)`))?.[1];

  if (!job) {
    throw new Error(`CI workflow is missing the ${name} job.`);
  }

  return job;
}

const buildTestJob = getJob('build-test');
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

const compatJob = getJob('compat');
const compatBuildIndex = compatJob.indexOf('- run: pnpm build\n');
const compatTestIndex = compatJob.indexOf('- run: pnpm --filter @osas/compat-suite test\n');

if (compatBuildIndex === -1 || compatTestIndex === -1 || compatBuildIndex > compatTestIndex) {
  throw new Error(
    'CI compat job must build workspace package entry points before running the compatibility suite.',
  );
}
