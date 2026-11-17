// Compatibility entry point. The complete runner lives in megascans-runner.cjs.
const runner = require('./megascans-runner.cjs');
if (require.main === module) runner.main().catch(error => { console.error(`[已停止] ${error.message}`); process.exitCode = 1; });
module.exports = runner;
