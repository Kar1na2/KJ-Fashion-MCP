import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import type { ConfirmRequest } from "../shared";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

let conn: DuckDBConnection | null = null;

export async function initDb(): Promise<void> {
    const dbPath = "data/inventory.duckdb";

    const instance = await DuckDBInstance.fromCache(dbPath);

    conn = await instance.connect();

    const schema = readFileSync(resolve("sql/schema.sql"), "utf8");
    await conn.run(schema);

    console.log(`[db] ready at ${dbPath}`);
}

// BRONZE

export async function insertBronze(
    scanId: string,
    sourceImage: string
): Promise<void> {
    const db = getDb();

    await db.run(
        `INSERT INTO bronze_scans (scan_id, source_image, status)
        VALUES ($id, $img, 'pending')`,
        {
            id: scanId,
            img: sourceImage,
        }
    );
}

// SILVER

export async function confirmScan(
    req: ConfirmRequest
): Promise<number> {
    const db = getDb();
    await db.run("BEGIN TRANSACTION");
    try {
        await db.run("DELETE FROM silver_inventory WHERE scan_id = $id", { id: req.scan_id });

        const stmt = await db.prepare(
            `INSERT INTO silver_inventory
            (scan_id, sheet_date, fashion_line, style_code, color, waist, inseam, quantity, confidence)
            VALUES ($scan, $date, $line, $style, $color, $waist, $inseam, $qty, $conf)`
        );

        for (const cell of req.cells) {
            stmt.bind({
                scan: req.scan_id,
                date: req.sheet_date,
                line: req.fashion_line,
                style: cell.style_code,
                color: cell.color,
                waist: cell.waist,
                inseam: cell.inseam,
                qty: cell.quantity,
                conf: cell.confidence,
            });
            await stmt.run();
        }

        await db.run("UPDATE bronze_scans SET status = 'confirmed' WHERE scan_id = $id", {
            id: req.scan_id,
        });

        await db.run("COMMIT");
        return req.cells.length;
    } catch (err) {
        await db.run("ROLLBACK");
        throw err;
    }
}

// GOLD

function clean(rows: Record<string, unknown>[]): Record<string, unknown>[] {
    return rows.map((row) => {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(row)) {
            if (typeof v === "bigint") out[k] = Number(v);
            else if (v && typeof v === "object" && "micros" in (v as any)) {
                out[k] = new Date(Number((v as any).micros) / 1000).toISOString().slice(0, 10);
            } else out[k] = v;
        }
        return out;
    });
}

export async function getWeeklyTrend(start_date: string, end_date: string) {
    const c = getDb();
    const reader = await c.runAndReadAll(
        `SELECT sheet_date, style_code, color, SUM(quantity) AS qty
            FROM silver_inventory
        WHERE sheet_date BETWEEN $start AND $end
        GROUP BY 1, 2, 3
        ORDER BY sheet_date, style_code, color`,
        { start: start_date, end: end_date }
    );
    return clean(reader.getRowObjects() as Record<string, unknown>[]);
}

export async function getMonthlyTrend(year: number, month: number) {
    const c = getDb();
    const reader = await c.runAndReadAll(
        `SELECT month, style_code, color, SUM(total_qty) AS qty
            FROM gold_monthly
        WHERE year(month) = $yr AND month(month) = $mo
        GROUP BY 1, 2, 3
        ORDER BY style_code, color`,
        { yr: year, mo: month }
    );
    return clean(reader.getRowObjects() as Record<string, unknown>[]);
}

export async function getYearlyTrend(year: number) {
    const c = await getDb();
    const reader = await c.runAndReadAll(
        `SELECT month, style_code, color, SUM(total_qty) AS qty
            FROM gold_monthly
        WHERE year(month) = $yr
        GROUP BY 1, 2, 3
        ORDER BY month, style_code, color`,
        { yr: year }
    );
    return clean(reader.getRowObjects() as Record<string, unknown>[]);
}

export async function getStyleHistory(styleCode: string) {
    const c = await getDb();
    const reader = await c.runAndReadAll(
        `SELECT month, color, SUM(total_qty) AS qty
            FROM gold_monthly
        WHERE style_code = $s
        GROUP BY 1, 2
        ORDER BY month`,
        { s: styleCode }
    );
    return clean(reader.getRowObjects() as Record<string, unknown>[]);
}

export async function listStyles() {
    const c = await getDb();
    const reader = await c.runAndReadAll(
        `SELECT DISTINCT style_code, color FROM silver_inventory ORDER BY style_code`
    );
    return clean(reader.getRowObjects() as Record<string, unknown>[]);
}

// helper function
export function getDb(): DuckDBConnection {
    if (!conn) throw new Error("DB not initialized — call initDb() first");
    return conn;
}