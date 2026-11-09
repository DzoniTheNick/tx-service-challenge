import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import agents from "agents/vite";

export default defineConfig({
  plugins: [agents(), react(), cloudflare(), tailwindcss()],
  // Bind all interfaces (not just ::1) so the containerized dev server is
  // reachable from the host browser via the Docker/OrbStack port forward.
  server: { host: true }
});
