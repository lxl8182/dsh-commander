import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { agentCommand, doctor, loadConfig } from '../src/config.mjs';

test('doctor accepts the DSH built-in provider and defers default catalog to ACP',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-doctor-'));
  try {
    fs.mkdirSync(path.join(root,'apps/cli/lib'),{recursive:true});
    fs.writeFileSync(path.join(root,'apps/cli/lib/bin.js'),'');
    fs.writeFileSync(path.join(root,'settings.yaml'),'{}');
    const config={dshRoot:root,dshHome:root,stateDir:root,provider:'deepseek-official',model:'deepseek-flash'};
    const result=doctor(config);
    assert.equal(result.credentialReference,'DEEPSEEK_API_KEY');
    assert.match(result.modelCatalogCheck,/Built-in DSH/);
    assert.throws(()=>doctor({...config,provider:'missing'}),/do not contain/);
    fs.writeFileSync(path.join(root,'settings.yaml'),'llm-deepseek:\n  apiKeyEnv: CUSTOM_REF\n  models:\n    - id: custom-model\n');
    assert.throws(()=>doctor(config),/do not contain/);
    assert.equal(doctor({...config,model:'custom-model'}).credentialReference,'CUSTOM_REF');
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('npm launch mode does not require a source checkout',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-npm-launch-'));
  try {
    fs.writeFileSync(path.join(root,'settings.yaml'),'{}');
    const config={dshLaunchMode:'npm',dshPackage:'@deepseek-ai/dsh@latest',dshRoot:path.join(root,'unused-source'),dshHome:root,stateDir:root,
      provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:'high'};
    const result=doctor(config);
    assert.equal(result.dshLaunchMode,'npm');
    assert.equal(result.dshRoot,null);
    assert.equal(result.dshPackage,'@deepseek-ai/dsh@latest');
    const command=agentCommand(config);
    assert.equal(command[0],process.platform==='win32'?'npx.cmd':'npx');
    assert.deepEqual(command.slice(1,5),['--yes','@deepseek-ai/dsh@latest','--profile','acp']);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('loaded npm configuration ignores the source-only default root',()=>{
  const state=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-config-npm-'));
  const previousHome=process.env.DSH_COMMANDER_HOME;
  try {
    fs.writeFileSync(path.join(state,'config.json'),JSON.stringify({dshLaunchMode:'npm'}));
    process.env.DSH_COMMANDER_HOME=state;
    const config=loadConfig();
    assert.equal(config.dshLaunchMode,'npm');
    assert.equal(config.dshPackage,'@deepseek-ai/dsh@latest');
    assert.equal(config.dshRoot,undefined);
  } finally {
    if(previousHome===undefined)delete process.env.DSH_COMMANDER_HOME;
    else process.env.DSH_COMMANDER_HOME=previousHome;
    fs.rmSync(state,{recursive:true,force:true});
  }
});

test('source launch mode runs the pnpm dsh script from the configured checkout',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-source-launch-'));
  try {
    fs.mkdirSync(path.join(root,'apps/cli/lib'),{recursive:true});
    fs.writeFileSync(path.join(root,'apps/cli/lib/bin.js'),'');
    fs.writeFileSync(path.join(root,'settings.yaml'),'{}');
    const config={dshLaunchMode:'source',dshRoot:root,dshHome:root,stateDir:root,
      provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:'high'};
    const command=agentCommand(config);
    assert.equal(command[0],process.platform==='win32'?'pnpm.cmd':'pnpm');
    assert.deepEqual(command.slice(1,5),['--dir',root,'dsh','--profile']);
    assert.equal(command[5],'acp');
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
