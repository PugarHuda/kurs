import { defineConfig, devices } from "@playwright/test";

// Runs against the production build served by `vite preview`, reading live Sepolia data.
// Set KURS_BASE_URL to test a deployed site instead (e.g. https://kurs-ten-zeta.vercel.app).
const external = process.env.KURS_BASE_URL;

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  expect: { timeout: 45_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: external ?? "http://localhost:4173",
    channel: process.env.CI ? undefined : "chrome", // local runs use the installed Chrome
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1360, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: external
    ? undefined
    : { command: "npm run build && npx vite preview --port 4173 --strictPort", port: 4173, reuseExistingServer: true, timeout: 120_000 },
});
