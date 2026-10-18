import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import packageJson from "./package.json";

export default defineConfig({
  plugins: [react()],
  // The app version shown in the corner comes from package.json's "version".
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8000",
    },
  },
});
