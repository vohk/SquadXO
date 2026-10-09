import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile('scripts/pr-validation-route.mjs', 'utf8');
const route = (await import(
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
)) as {
  documentationOnly(files: readonly string[]): boolean;
  validationPassed(
    route: string,
    routeResult: string,
    docsResult: string,
    fullResult: string
  ): boolean;
};

test('only explicit documentation paths use the database-free route', () => {
  assert.equal(
    route.documentationOnly([
      'README.md',
      'docs/deployment/production.md',
      'squad-server/templates/readme-template.md',
      'deployment/amp/README.md'
    ]),
    true
  );
  for (const file of [
    'src/main.ts',
    'package-lock.json',
    'config.example.json',
    'squad-server/templates/config-template.json',
    '.github/workflows/validate-pr.yml',
    'scripts/pr-validation-route.mjs',
    'test/config/runtime-config.test.ts',
    'deployment/shared/install.mjs',
    'unknown.md',
    'docs/../src/main.ts',
    'README.md\nscript.sh'
  ]) {
    assert.equal(route.documentationOnly(['README.md', file]), false, file);
  }
  assert.equal(route.documentationOnly([]), false);
});

test('required check fails closed for failed, skipped or unknown routes', () => {
  assert.equal(route.validationPassed('true', 'success', 'success', 'skipped'), true);
  assert.equal(route.validationPassed('false', 'success', 'skipped', 'success'), true);
  for (const state of ['failure', 'cancelled', 'skipped', '']) {
    assert.equal(route.validationPassed('true', 'success', state, 'skipped'), false);
    assert.equal(route.validationPassed('false', 'success', 'skipped', state), false);
    assert.equal(route.validationPassed('true', state, 'success', 'skipped'), false);
  }
  assert.equal(route.validationPassed('', 'success', 'success', 'success'), false);
  assert.equal(route.validationPassed('false', 'success', 'success', 'skipped'), false);
});

test('service-free paths remain separate and publication depends on full validation', async () => {
  const pr = await readFile('.github/workflows/validate-pr.yml', 'utf8');
  const build = await readFile('.github/workflows/build.yml', 'utf8');
  const action = await readFile('.github/actions/package-validation/action.yml', 'utf8');
  const docs = pr.slice(pr.indexOf('  documentation:'), pr.indexOf('  full:'));
  const preview = build.slice(build.indexOf('  preview:'), build.indexOf('\n  release:'));
  assert.doesNotMatch(docs + preview, /services:|DB_TEST_/);
  assert.match(pr, /name: PR validation\n {4}if: always\(\)/);
  assert.match(
    build,
    / {2}validate:\n {4}if: github.event_name == 'push' \|\| inputs.release == true/
  );
  assert.match(build, / {2}release:[\s\S]*?needs: validate/);
  assert.match(preview, /full-tests: 'false'/);
  assert.match(build.slice(0, build.indexOf('  preview:')), /full-tests: 'true'/);
  assert.match(action, /run: npm test\n {6}shell: bash\n {6}if: inputs.full-tests == 'true'/);
  for (const workflow of [pr, build]) {
    assert.equal(workflow.match(/username: \$\{\{ secrets.DOCKERHUB_USERNAME \}\}/g)?.length, 2);
    assert.equal(workflow.match(/password: \$\{\{ secrets.DOCKERHUB_TOKEN \}\}/g)?.length, 2);
    assert.doesNotMatch(workflow, /pull_request_target/);
  }
});
