import { buildReferenceFile } from './plugin-metadata.js';

buildReferenceFile().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
