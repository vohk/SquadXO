import { buildReadmeFile } from './plugin-metadata.js';

console.log('Building readme...');
buildReadmeFile()
  .then(() => {
    console.log('Done.');
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
