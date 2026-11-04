// The dashboard's wallet pull, end to end on Sepolia with a real transaction: window.ethereum
// is an EIP-1193 provider whose eth_sendTransaction is signed in Node by the deployer key
// (everything else goes to the public RPC). Runs only where DEPLOYER_PK is set (kurs/.env);
// CI has no key and skips it.
import { existsSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const envFile = new URL("../../.env", import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);
const pk = process.env.DEPLOYER_PK as Hex | undefined;
const RPC = "https://ethereum-sepolia-rpc.publicnode.com";


test("a visitor's wallet pulls the verified bundle and converts $100 in one Sepolia transaction", async ({ page }, info) => {
  test.skip(!pk, "needs DEPLOYER_PK (a Sepolia key with gas)");
  test.skip(info.project.name !== "desktop", "one real transaction per run");
  test.setTimeout(240_000);
  const account = privateKeyToAccount(pk!);
  const wallet = createWalletClient({ account, chain: sepolia, transport: http(RPC) });
  await page.exposeFunction("__kursRpc", async (method: string, params: unknown[]) => {
    if (method === "eth_requestAccounts" || method === "eth_accounts") return [account.address];
    if (method === "eth_chainId") return "0xaa36a7";
    if (method === "eth_sendTransaction") {
      const t = params[0] as { to: Hex; data: Hex; value?: Hex };
      return wallet.sendTransaction({ to: t.to, data: t.data, value: t.value ? BigInt(t.value) : 0n });
    }
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  });
  await page.addInitScript(() => {
    (window as any).ethereum = { request: ({ method, params }: { method: string; params?: unknown[] }) => (window as any).__kursRpc(method, params ?? []), on() {}, removeListener() {} };
  });
  await page.goto("/?net=sepolia&feed=USD%2FIDR");
  await page.selectOption("#pull-pair", "USD/IDR");
  await page.click("#pull-form button");
  await expect(page.locator("#pull-out")).toContainText("Every signature checks out", { timeout: 60_000 });
  await page.click("#wallet-pull");
  await expect(page.locator("#wallet-out")).toContainText(/\$100\.00 = Rp [\d,]+\.\d{2}/, { timeout: 180_000 });
  const tx = await page.locator("#wallet-out a").first().getAttribute("href");
  console.log("wallet pull tx:", tx, await page.locator("#wallet-out").innerText());
});

test("without a wallet the pull panel says how to do it instead", async ({ page }) => {
  await page.goto("/?net=sepolia&feed=USD%2FIDR");
  await page.selectOption("#pull-pair", "USD/IDR");
  await page.click("#pull-form button");
  await expect(page.locator("#wallet-out")).toContainText(/browser wallet .* kurs pull-convert/, { timeout: 60_000 });
});
