import { dec, str } from './decimal.mjs';

// Reconstruct sale cost basis from the full bot-owned order ledger, never the UI slice.
export function performance(orders) {
  const positions = new Map(), stats = {}, sales = {};
  for (const o of Object.values(orders).sort((a,b)=>a.created-b.created)) {
    const tally = stats[o.bot] ??= {wins:0, losses:0, breakeven:0, unknown:0};
    const quantity = dec(o.filled || '0');
    if (quantity <= 0n) continue;
    const key = o.bot + ':' + o.product;
    const p = positions.get(key) || {quantity:0n,cost:0n};
    const value = dec(o.value || '0'), fees = dec(o.fees || '0');
    if (o.side === 'BUY') {
      p.quantity += quantity; p.cost += value + fees;
      positions.set(key,p);
    } else if (o.side === 'SELL') {
      if (p.quantity < quantity) {
        sales[o.id] = null;
        if(o.status === 'SETTLED') tally.unknown++;
        continue;
      }
      const basis = p.cost * quantity / p.quantity;
      const pnl = value - fees - basis;
      sales[o.id] = str(pnl);
      p.quantity -= quantity; p.cost -= basis;
      positions.set(key,p);
      if(o.status === 'SETTLED') tally[pnl>0n?'wins':pnl<0n?'losses':'breakeven']++;
    }
  }
  return {sales,stats};
}
