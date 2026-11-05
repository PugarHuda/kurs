import { fallback, http, type HttpTransportConfig } from "viem";

// A cold serverless instance on one public Sepolia node sometimes gets a 5xx or a pruned
// response; a second public provider (verified to serve 45k-block getLogs) keeps the API up.
const SEPOLIA_BACKUP = "https://sepolia.gateway.tenderly.co";
export const transportFor = (url: string, opts?: HttpTransportConfig) =>
  url.includes("sepolia") ? fallback([http(url, opts), http(SEPOLIA_BACKUP, opts)]) : http(url, opts);
