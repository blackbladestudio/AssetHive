// Test-only Electron entry: exercise the actual importer through its existing
// local worker IPC, with an isolated library/profile supplied by the runner.
const path = require('node:path');
const implementation = process.env.ASSETHIVE_VERIFY_IMPLEMENTATION;
if (!implementation || process.env.ASSETHIVE_MEGASCANS_IMPORT_WORKER !== '1') throw new Error('Verification worker only');
const batch = require(path.join(implementation, 'electron/services/megascansBatchImport.js'));
batch.runImportJob = (job, api) => {
  if (!path.resolve(job.library).startsWith(path.resolve(process.env.ASSETHIVE_VERIFY_ROOT) + path.sep)) throw new Error('Isolated verification library required');
  return api.importAsset(job.payload);
};
require(path.join(implementation, 'electron/main.js'));
