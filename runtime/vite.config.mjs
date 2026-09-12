import { defineConfig } from "vite";

import { phrase2PhotonLibraryPlugin } from "./src/library/vitePlugin.js";

export default defineConfig({
  plugins: [phrase2PhotonLibraryPlugin()],
  server: {
    port: 5173,
    strictPort: false
  }
});
