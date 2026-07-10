import { projectMetadata } from './index.js';

process.stdout.write(
  `${projectMetadata.name}: Phase ${projectMetadata.phase} provider adapters ready\n`,
);
