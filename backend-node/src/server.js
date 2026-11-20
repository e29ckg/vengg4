import { startApplication,attachShutdown } from './runtime.js';
const runtime=await startApplication();
attachShutdown(runtime);
console.log(`Vengg4 Node backend listening on ${runtime.config.host}:${runtime.config.port}`);
