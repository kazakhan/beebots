// Read-only integration probe. No Engine, Store, order or execution imports.
import {readFileSync} from 'node:fs';
import {Laya} from './laya.mjs';
import {DecisionModel} from './model.mjs';
import {migrateConfig} from './migrate-v2.mjs';
const c=migrateConfig(JSON.parse(readFileSync('/etc/beebots/config.json','utf8')));
const evidence=JSON.parse(readFileSync('/var/lib/beebots-shadow-v2/evidence.json','utf8'));
const laya=new Laya(c.layaSocket,c.layaTimeoutMs);
const model=new DecisionModel(c.model,c.modelTimeoutMs);
console.log(JSON.stringify({layaHealth:await laya.ping()}));
for(const id of ['breakout','trend','momentum']) {
 const rows=evidence[id];
 if(!rows?.length) throw Error(`No real evidence for ${id}`);
 const f=rows.find(x=>x.setupEligible) || rows.find(x=>!['BTC-USDC','ETH-USDC','SOL-USDC'].includes(x.product)) || rows[0];
 const analysis=await laya.analyze(f,id);
 const d=await model.decide({strategy:readFileSync(new URL(`../strategies/v2/${id}.md`,import.meta.url),'utf8'),bot:{name:c.bots[id].name,cash:'100',position:null},candidates:[{...f,analysis}]});
 console.log(JSON.stringify({bot:id,product:f.product,setupEligible:f.setupEligible,regime:analysis.answers.regime.choice,fit:analysis.answers.fit.score,layaSeconds:analysis.elapsed_s,model:d.model,action:d.action,reason:d.reason,probeOnly:true}));
}
