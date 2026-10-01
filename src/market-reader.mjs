import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Coinbase } from "./coinbase.mjs";
export class MarketReader extends Coinbase {
  constructor(config, pace) {
    super({ ...config, mode: "observe" });
    this.pace = pace;
    this.child = null;
  }
  call(action, args = {}) {
    if (!["products", "product", "candles", "book", "trades"].includes(action))
      return Promise.reject(Error("Read-only market worker"));
    const run = async () => {
      await this.pace();
      if (!this.child) {
        this.child = spawn(
          this.config.coinbasePython,
          ["-B", fileURLToPath(new URL("./market_worker.py", import.meta.url))],
          {
            env: {
              ...process.env,
              COINBASE_KEY_FILE: this.config.coinbaseKeyFile,
              COINBASE_PORTFOLIO: this.config.coinbasePortfolioId ?? "",
              COINBASE_LIVE: "0",
            },
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          },
        );
        this.child.stderr.on("data", () => {});
        this.child.stdin.on("error", () => {});
      }
      const child = this.child;
      return new Promise((resolve, reject) => {
        let text = "",
          done = false;
        const finish = (error, data) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          child.stdout.off("data", dataHandler);
          child.off("error", failed);
          child.off("close", failed);
          if (error) {
            child.kill();
            if (this.child === child) this.child = null;
            reject(error);
          } else resolve(data);
        };
        const failed = () => finish(Error("Market worker unavailable"));
        const timer = setTimeout(
          () => finish(Error("Market read timed out")),
          25000,
        );
        const dataHandler = (chunk) => {
          text += chunk.toString();
          if (text.length > 8e6)
            return finish(Error("Market response too large"));
          const end = text.indexOf("\n");
          if (end < 0) return;
          try {
            const r = JSON.parse(text.slice(0, end));
            if (!r.ok)
              return finish(
                Error(
                  `Market ${action}: ${r.error}${r.status ? " HTTP " + r.status : ""}`,
                ),
              );
            finish(null, r.data);
          } catch {
            finish(Error("Invalid market response"));
          }
        };
        child.stdout.on("data", dataHandler);
        child.once("error", failed);
        child.once("close", failed);
        child.stdin.write(JSON.stringify({ action, args }) + "\n");
      });
    };
    const result = this.tail.then(run);
    this.tail = result.catch(() => {});
    return result;
  }
  close() {
    this.child?.kill();
    this.child = null;
  }
}
