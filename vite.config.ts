import { defineConfig } from "vite";

export default defineConfig({
    root: "src/frontend",
    server: {
        port: 5173,
        proxy: {
            "/api": "http://localhost:8787",
        },
    },
});