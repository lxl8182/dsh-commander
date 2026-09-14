import { loadConfig } from '../src/config.mjs';
import { ensureDaemon, rpc } from '../src/ipc.mjs';
const config=loadConfig();const method=process.argv[2]||'doctor';
const args=process.argv[3]?JSON.parse(process.argv[3]):{};
await ensureDaemon(config);console.log(JSON.stringify(await rpc(config,method,args,150000),null,2));
