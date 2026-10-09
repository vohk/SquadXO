import { buildConfigFile } from './plugin-metadata.js';

console.log('Building config...');
buildConfigFile()
  .then(() => {
    console.log('Done.');
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
