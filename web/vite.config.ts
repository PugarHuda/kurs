import { defineConfig } from "vite";

// /api/* are Vercel functions, not part of the Vite build: local dev and the e2e preview
// send them to the deployed API.
const api = { "/api": { target: "https://kurs-ten-zeta.vercel.app", changeOrigin: true } };

// The page imports feed config and ABIs straight from ../reporter so both stay in sync.
export default defineConfig({
  server: { fs: { allow: [".."] }, port: 5173, proxy: api },
  preview: { proxy: api },
});
