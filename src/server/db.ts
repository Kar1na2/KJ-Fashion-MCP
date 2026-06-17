import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import type { ConfirmRequest } from "../shared";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

let conn: DuckDBConnection | null = null;

// Every cell is refilled to this baseline each Sunday. The Saturday count sheet
// records how many units remain, so Silver stores the weekly difference
// (FULL_STOCK - counted) = units sold/used that week, never below zero. That
// same difference is exactly how many units the cell needs to be refilled, so
// the restock checklist is derived from it (see restock.ts).
export const FULL_STOCK = 3;

// Sheets are counted on Saturdays, but a week is keyed by the Sunday it began on
// (6 days before the count). e.g. counted Sat 2026-06-13 -> week start 2026-06-07.
function toWeekStart(saturdayIso: string): string {
    const d = new Date(`${saturdayIso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 6);
    return d.toISOString().slice(0, 10);
}

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

        // Store the Sunday the week started on, not the Saturday it was counted.
        const weekStart = req.sheet_date ? toWeekStart(req.sheet_date) : null;

        const stmt = await db.prepare(
            `INSERT INTO silver_inventory
            (scan_id, sheet_date, fashion_line, style_code, color, waist, inseam, quantity, confidence)
            VALUES ($scan, $date, $line, $style, $color, $waist, $inseam, $qty, $conf)`
        );

        for (const cell of req.cells) {
            stmt.bind({
                scan: req.scan_id,
                date: weekStart,
                line: req.fashion_line,
                style: cell.style_code,
                color: cell.color,
                waist: cell.waist,
                inseam: cell.inseam,
                qty: Math.max(0, FULL_STOCK - cell.quantity),
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

// RECORDS (admin viewing / editing / deleting)

// One row per stored week: the confirmed bronze scan joined to its silver rows,
// keyed by the Sunday the week began (sheet_date). total_sold is the units
// sold/used that week (already stored as max(0, 3 - count) in Silver).
export async function listWeeks() {
    const c = getDb();
    const reader = await c.runAndReadAll(
        `SELECT b.scan_id            AS scan_id,
                b.source_image       AS source_image,
                b.ingested_at        AS ingested_at,
                s.sheet_date         AS sheet_date,
                any_value(s.fashion_line) AS fashion_line,
                COUNT(*)             AS line_count,
                SUM(s.quantity)      AS total_sold
           FROM bronze_scans b
           JOIN silver_inventory s ON s.scan_id = b.scan_id
          WHERE b.status = 'confirmed'
          GROUP BY b.scan_id, b.source_image, b.ingested_at, s.sheet_date
          ORDER BY s.sheet_date DESC`
    );
    return clean(reader.getRowObjects() as Record<string, unknown>[]);
}

// Full detail for a single stored week: the bronze scan meta plus every Silver
// row (units sold). Returns null if the scan does not exist.
export async function getWeekDetail(scanId: string) {
    const c = getDb();
    const metaReader = await c.runAndReadAll(
        `SELECT scan_id, source_image, status, ingested_at
           FROM bronze_scans WHERE scan_id = $id`,
        { id: scanId }
    );
    const metaRows = clean(metaReader.getRowObjects() as Record<string, unknown>[]);
    if (metaRows.length === 0) return null;

    const cellReader = await c.runAndReadAll(
        `SELECT scan_id, sheet_date, fashion_line, style_code, color, waist, inseam, quantity, confidence
           FROM silver_inventory WHERE scan_id = $id
          ORDER BY style_code, color, waist, inseam`,
        { id: scanId }
    );
    return {
        scan: metaRows[0],
        cells: clean(cellReader.getRowObjects() as Record<string, unknown>[]),
    };
}

// The stored bronze image filename for a scan, or null if missing.
export async function getScanImage(scanId: string): Promise<string | null> {
    const c = getDb();
    const reader = await c.runAndReadAll(
        `SELECT source_image FROM bronze_scans WHERE scan_id = $id`,
        { id: scanId }
    );
    const rows = reader.getRowObjects();
    return rows.length ? String((rows[0] as Record<string, unknown>).source_image) : null;
}

// Remove a stored week entirely — its Silver rows and its Bronze scan record.
// Returns the source_image filename so the caller can unlink the file on disk.
export async function deleteWeek(scanId: string): Promise<string | null> {
    const db = getDb();
    const img = await getScanImage(scanId);
    await db.run("BEGIN TRANSACTION");
    try {
        await db.run("DELETE FROM silver_inventory WHERE scan_id = $id", { id: scanId });
        await db.run("DELETE FROM bronze_scans WHERE scan_id = $id", { id: scanId });
        await db.run("COMMIT");
        return img;
    } catch (err) {
        await db.run("ROLLBACK");
        throw err;
    }
}

// helper function
export function getDb(): DuckDBConnection {
    if (!conn) throw new Error("DB not initialized — call initDb() first");
    return conn;
}