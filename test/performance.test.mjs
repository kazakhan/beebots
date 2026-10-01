import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from '../src/performance.mjs';
const o=(id,side,filled,value,fees,created,status='SETTLED',bot='trend')=>({id,bot,product:'X-USDC',side,filled,value,fees,created,status});
test('sale P/L allocates entry fees across partial exits and counts settled sales only',()=>{
 const orders=[o('b','BUY','10','100','1',1),o('s1','SELL','4','48','0.5',2),o('s2','SELL','6','54','0.5',3)];
 const p=performance(orders);
 assert.equal(p.sales.s1,'7.1');assert.equal(p.sales.s2,'-7.1');
 assert.deepEqual(p.stats.trend,{wins:1,losses:1,breakeven:0,unknown:0});
 orders[2].status='OPEN';assert.equal(performance(orders).stats.trend.losses,0);
 assert.deepEqual(performance(orders),performance(orders));
});
test('breakeven, missing basis and independent bots are distinguished',()=>{
 const p=performance([o('b','BUY','1','10','1',1),o('s','SELL','1','12','1',2),o('x','SELL','1','99','1',3,'SETTLED','breakout')]);
 assert.equal(p.sales.s,'0');assert.equal(p.stats.trend.breakeven,1);
 assert.equal(p.sales.x,null);assert.equal(p.stats.breakout.unknown,1);
});
