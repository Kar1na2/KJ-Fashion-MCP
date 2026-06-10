import { defineConfig } from "vite";

export default defineConfig({
    root: "src/frontend",
    server: {
        host: "0.0.0.0",
        port: 5173,
        proxy: {
            "/api": "http://localhost:8787",
        },
    },
});