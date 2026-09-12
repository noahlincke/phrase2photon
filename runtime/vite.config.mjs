import { resolve } from "node:path";

import { defineConfig } from "vite";

import { phrase2PhotonLibraryPlugin } from "./src/library/vitePlugin.js";

const here = import.meta.dirname;

export default defineConfig({
  plugins: [phrase2PhotonLibraryPlugin()],
  server: {
    port: 5173,
    strictPort: false
  },
  build: {
    rollupOptions: {
      // Vite only builds index.html unless the other pages are named. Without
      // this, show.html works in dev and 404s in a production build, which is
      // exactly the sort of thing that is discovered during a set.
      input: {
        main: resolve(here, "index.html"),
        show: resolve(here, "show.html"),
        preview: resolve(here, "preview.html")
      }
    }
  }
});
