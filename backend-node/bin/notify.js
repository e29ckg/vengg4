import { configFromEnv } from '../src/config.js';
import { createDatabase } from '../src/db.js';
import { Integrations } from '../src/integrations.js';

const config = configFromEnv(), db = createDatabase(config), integration = new Integrations(db,config);
const atIndex = process.argv.indexOf('--at'), supplied = atIndex >= 0 ? process.argv[atIndex + 1] : null;
if (supplied && !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(supplied)) throw new Error('--at requires an ISO timestamp with timezone');
const now = () => supplied ? new Date(supplied) : new Date();
if (!Number.isFinite(now().getTime())) throw new Error('Invalid --at timestamp');
const dryRun = process.argv.includes('--dry-run'), loop = process.argv.includes('--loop');
if (supplied && !dryRun) throw new Error('--at is for dry-run only');
async function run() { console.log(JSON.stringify(await integration.notify(now(),dryRun))); }
try {
  if (!loop) await run();
  else {
    let stop = false;
    for (const signal of ['SIGTERM','SIGINT']) process.on(signal,() => { stop = true; });
    while (!stop) { await run().catch(() => console.error('Notification iteration failed')); await new Promise(resolve => setTimeout(resolve,20000)); }
  }
} finally { await db.end(); }
