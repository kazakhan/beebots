import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
export class Coinbase {
  constructor(config) {
    this.config = config;
    this.tail = Promise.resolve();
  }
  call(action, args = {}) {
    const run = () => {
      // Credential precedence: the environment is authoritative and never
      // overwritten by the config, so a secret can stay out of config.json.
      const env = {
        ...process.env,
        COINBASE_PORTFOLIO: this.config.coinbasePortfolioId ?? "",
        COINBASE_LIVE: this.config.mode === "live" ? "1" : "0",
      };
      if (
        !env.COINBASE_KEY_NAME &&
        this.config.coinbaseApiKeyName &&
        this.config.coinbaseApiKeySecret
      ) {
        env.COINBASE_KEY_NAME = this.config.coinbaseApiKeyName;
        env.COINBASE_KEY_SECRET = this.config.coinbaseApiKeySecret;
      }
      if (!env.COINBASE_KEY_FILE && this.config.coinbaseKeyFile)
        env.COINBASE_KEY_FILE = this.config.coinbaseKeyFile;
      return new Promise((resolve, reject) => {
        const child = spawn(
          this.config.coinbasePython,
          [
            "-B",
            fileURLToPath(new URL("./coinbase_bridge.py", import.meta.url)),
          ],
          {
            env,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          },
        );
        let output = "",
          done = false;
        const timer = setTimeout(() => {
          child.kill();
          finish(Error("Coinbase request timed out; outcome may be unknown"));
        }, 25000);
        const finish = (err, r) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          err ? reject(err) : resolve(r);
        };
        child.on("error", () => finish(Error("Coinbase bridge unavailable")));
        child.stdin.on("error", () => {});
        child.stderr.on("data", () => {}); // SDK errors can include private request details.
        child.stdout.on("data", (v) => {
          output += v.toString();
          if (output.length > 8e6) {
            child.kill();
            finish(Error("Coinbase response too large"));
          }
        });
        child.on("close", () => {
          try {
            const r = JSON.parse(output);
            if (!r.ok) throw Error("Coinbase operation failed");
            finish(null, r.data);
          } catch {
            finish(Error("Coinbase operation failed"));
          }
        });
        child.stdin.end(JSON.stringify({ action, args }));
      });
    };
    const p = this.tail.then(run);
    this.tail = p.catch(() => {});
    return p;
  }
  product(id) {
    return this.call("product", { product_id: id });
  }
  async products() {
    const products = [],
      seen = new Set();
    for (let offset = 0; offset < 25000; offset += 1000) {
      const r = await this.call("products", { offset });
      if (!Array.isArray(r.products)) throw Error("Invalid product catalogue");
      if (!r.products.length) return { products };
      const before = seen.size;
      for (const p of r.products) {
        if (seen.has(p.product_id)) continue;
        seen.add(p.product_id);
        products.push(p);
      }
      if (seen.size === before)
        throw Error("Catalogue pagination made no progress");
      if (r.products.length < 1000) return { products };
    }
    throw Error("Catalogue pagination exhausted");
  }
  candles(id, start, end, granularity) {
    return this.call("candles", {
      product_id: id,
      start: String(start),
      end: String(end),
      granularity,
    });
  }
  book(id) {
    return this.call("book", { product_id: id });
  }
  trades(id, start, end) {
    return this.call("trades", {
      product_id: id,
      start: String(start),
      end: String(end),
    });
  }
  accounts() {
    return this.call("accounts");
  }
  fees() {
    return this.call("fees");
  }
  create(order) {
    return this.call("create", order);
  }
  order(id) {
    return this.call("order", { order_id: id });
  }
  find(clientId, created) {
    return this.call("find", {
      client_id: clientId,
      start_date: new Date(created - 60000).toISOString(),
    });
  }
}
