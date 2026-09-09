import type { AppConfig } from "../config.js";
import { fetchJson } from "../lib/http.js";

type RpcResponse<T> = { result?: T; error?: { message?: string; code?: number } };

export class RobinhoodProvider {
  constructor(private readonly config: AppConfig) {}

  async health(): Promise<{ chainId: number; blockNumber: number }> {
    const chainId = await this.rpc<string>("eth_chainId", []);
    const block = await this.rpc<string>("eth_blockNumber", []);
    return { chainId: Number.parseInt(chainId, 16), blockNumber: Number.parseInt(block, 16) };
  }

  async getBalance(address: string): Promise<string> {
    const value = await this.rpc<string>("eth_getBalance", [address, "latest"]);
    return BigInt(value).toString();
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const url = this.config.alchemyApiKey
      ? `https://robinhood-mainnet.g.alchemy.com/v2/${encodeURIComponent(this.config.alchemyApiKey)}`
      : this.config.robinhoodRpcUrl;
    const response = await fetchJson<RpcResponse<T>>(url, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params })
    }, `Robinhood ${method}`);
    if (response.error) throw new Error(`Robinhood ${method}: ${response.error.message ?? "RPC error"}`);
    if (response.result === undefined) throw new Error(`Robinhood ${method}: result missing`);
    return response.result;
  }
}
