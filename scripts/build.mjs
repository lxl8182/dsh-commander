import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
const out=await build({entryPoints:['src/server.mjs','src/daemon.mjs'],outdir:'dist',bundle:true,platform:'node',target:'node22',format:'esm',outExtension:{'.js':'.mjs'},metafile:true,
  banner:{js:"import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);"},logLevel:'warning'});
fs.mkdirSync('dist',{recursive:true});
// Keep third-party notices alongside the self-contained bundles.
const notices=['DSH Commander dependency notices.\n'];
const roots=new Set();
for(const input of Object.keys(out.metafile.inputs)){
  const parts=input.replaceAll('\\','/').split('/');const idx=parts.lastIndexOf('node_modules');if(idx<0)continue;
  roots.add(parts.slice(0,idx+(parts[idx+1].startsWith('@')?3:2)).join('/'));
}
const dependencies=[];
for(const root of roots){
  const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
  const licenses=fs.readdirSync(root).filter(n=>/^(license|copying|notice)(\.|$)/i.test(n));
  dependencies.push({name:pkg.name,version:pkg.version,license:pkg.license});
  notices.push(`\n--- ${pkg.name}@${pkg.version} (${pkg.license}) ---\n`);
  for(const license of licenses)if(fs.statSync(path.join(root,license)).isFile())notices.push(fs.readFileSync(path.join(root,license),'utf8'));
}
fs.writeFileSync('dist/THIRD_PARTY_LICENSES.txt',notices.join('\n'));
fs.writeFileSync('dist/dependencies.json',JSON.stringify(dependencies,null,2));
console.log('Built self-contained MCP server and controller:',Object.keys(out.metafile.outputs).join(', '));
