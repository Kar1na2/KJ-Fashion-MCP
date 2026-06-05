import express from "express";
import multer from "multer";
import { nanoid } from "nanoid";
import { initDb, insertBronze, confirmScan, getDb, getYearlyTrend, getStyleHistory, listStyles } from "./db.js";
import "dotenv/config";
import { extractSheet, testClaude } from "./extractor.js";
import type { ConfirmRequest } from "../shared.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, extname } from "node:path";
import { DuckDBValue } from "@duckdb/node-api";

const app = express();
const PORT = 8787;
const BRONZE_DIR = "data/bronze";

app.use(express.json({ limit: "10mb" }));

mkdirSync(resolve(BRONZE_DIR), { recursive: true });

// Configure multer to keep the uploaded file in memory (as a Buffer of bytes)
// rather than auto-saving it. We want control over where/how it's saved.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 }, 
});

app.get("/api/ping", (req, res) => {
    res.json({ ok: true });
});

// The `upload.single("image")` part is multer middleware. It runs BEFORE your
// handler, finds the file in the form field named "image", and attaches it as req.file.
app.post("/api/extract", upload.single("image"), async (req, res) => {
    try {
        // multer gives us req.file, but only if a file was actually sent. Always check.
        if (!req.file) {
            return res.status(400).json({ error: "No image uploaded" });
        }

        const scanId = nanoid();
        const ext = (extname(req.file.originalname) || ".jpg").toLowerCase();
        const isPng = ext === ".png" || req.file.mimetype === "image/png";
        const fileName = `${scanId}${isPng ? ".png" : ".jpg"}`;

        writeFileSync(resolve(BRONZE_DIR, fileName), req.file.buffer);

        await insertBronze(scanId, fileName);

        const base64 = req.file.buffer.toString("base64");
        const mediaType = isPng ? "image/png" : "image/jpeg";

        console.log("[extract] calling Claude");
        const extraction = await extractSheet(base64, mediaType);
        console.log("[extract] result:", JSON.stringify(extraction, null, 2));

        res.json({ ok: true, scan_id: scanId, extraction });
    } catch (err) {
        console.error("[extract] error:", err);
        res.status(500).json({ error: (err as Error).message });
    }
});

app.post("/api/confirm", async (req, res) => {
    try {
        const body = req.body as ConfirmRequest;

        if (!body.scan_id || !Array.isArray(body.cells)) {
            return res.status(400).json({ error: "scan_id and cells[] are required" });
        }

        const iso = body.sheet_date;
        if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso) || isNaN(Date.parse(iso))) {
            return res.status(400).json({ error: "A valid sheet_date (YYYY-MM-DD) is required" });
        }

        const stored = await confirmScan(body);
        res.json({ ok: true, rows_stored: stored });
    } catch (err) {
        console.error("[confirm] error:" , err);
        res.status(500).json({ error: (err as Error).message });
    }
});

app.get("/api/scans", async (req, res) => {
    const db = getDb();
    const reader = await db.runAndReadAll("SELECT * FROM bronze_scans ORDER BY ingested_at");

    function fix(rows: Record<string, DuckDBValue>[]) {
        return JSON.parse(JSON.stringify(rows, (_, v) =>
            typeof v === "bigint" ? Number(v) : v
        ));
    }
    res.json(fix(reader.getRowObjects()));
});

app.get("/api/trend/:year", async (req, res) => {
    try {
        const year = Number(req.params.year);
        if (!Number.isInteger(year)) return res.status(400).json({ error: "year must be a number"});
        res.json(await getYearlyTrend(year));
    } catch (err) {
        res.status(500).json({ error: (err as Error).message });
    }
});

app.get("/api/style/:code", async (req, res) => {
    try {
        res.json(await getStyleHistory(req.params.code));
    } catch (err) {
        res.status(500).json({ error: (err as Error).message });
    }
});

app.get("/api/styles", async (req, res) => {
    try {
        res.json(await listStyles());
    } catch (err) {
        res.status(500).json({ error: (err as Error).message });
    }
});

await initDb();

console.log("[claude] testing connection...");
console.log("[claude]", await testClaude());

app.listen(PORT, () => {
    console.log(`[server] http://localhost:${PORT}`);
});