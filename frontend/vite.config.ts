import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      workbox: {
        navigateFallbackDenylist: [/^\/assets\//, /^\/api/, /^\/ws/, /\.[a-z0-9]+$/i],
        cleanupOutdatedCaches: true,
      },
      manifest: {
        name: "HomeFix",
        short_name: "HomeFix",
        description: "Guided home repairs on camera.",
        theme_color: "#12100e",
        background_color: "#12100e",
        display: "fullscreen",
        orientation: "portrait",
        icons: [
          { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
        ],
      },
    }),
  ],
  server: {
    proxy: {
      "/ws": { target: "ws://localhost:8080", ws: true },
      "/api": { target: "http://localhost:8080", changeOrigin: true },
    },
  },
});
