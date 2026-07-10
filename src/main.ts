import { projectMetadata } from './index.js';

process.stdout.write(
  `${projectMetadata.name}: ${projectMetadata.phase} scaffold ready\n`,
);
