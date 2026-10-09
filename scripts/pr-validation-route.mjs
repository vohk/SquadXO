import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function documentationOnly(files) {
  const approved = (file) =>
    [
      'README.md',
      'CONTRIBUTING.md',
      'squad-server/templates/readme-template.md',
      'squad-server/templates/reference-template.md'
    ].includes(file) ||
    /^docs\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.md$/.test(file) ||
    /^deployment\/(?:[A-Za-z0-9_-]+\/)*README\.md$/.test(file);
  return files.length > 0 && files.every(approved);
}
export function validationPassed(route, routeResult, docsResult, fullResult) {
  return (
    routeResult === 'success' &&
    ((route === 'true' && docsResult === 'success' && fullResult === 'skipped') ||
      (route === 'false' && fullResult === 'success' && docsResult === 'skipped'))
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args[0] === '--result' && args.length === 5) {
    if (!validationPassed(...args.slice(1)))
      throw new Error('Selected PR validation did not succeed');
  } else if (
    args[0] === '--diff' &&
    args.length === 3 &&
    args.slice(1).every((sha) => /^[a-f0-9]{40}$/.test(sha))
  ) {
    const { stdout } = await promisify(execFile)(
      'git',
      ['diff', '--name-only', '-z', '--no-renames', args[1], args[2]],
      { maxBuffer: 8 * 1024 * 1024 }
    );
    const files = stdout.split('\0').filter(Boolean);
    const result = documentationOnly(files);
    if (process.env.GITHUB_OUTPUT)
      await appendFile(process.env.GITHUB_OUTPUT, `documentation_only=${result}\n`);
    console.log(result ? 'Documentation validation selected' : 'Full database validation selected');
  } else
    throw new Error(
      'Usage: pr-validation-route.mjs --diff BASE HEAD | --result ROUTE ROUTE_RESULT DOCS_RESULT FULL_RESULT'
    );
}
