import { loadConfig, doctor } from '../src/config.mjs';
console.log(JSON.stringify(doctor(loadConfig()),null,2));
