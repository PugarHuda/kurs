import { defineConfig } from "vite";

// The page imports feed config and ABIs straight from ../reporter so both stay in sync.
export default defineConfig({
  server: { fs: { allow: [".."] }, port: 5173 },
});
