import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { doctor } from '../src/config.mjs';

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
