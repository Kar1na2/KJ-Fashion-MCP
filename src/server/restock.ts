// ---------------------------------------------------------------------------
// Refill checklist generation.
//
// Silver stores the weekly difference max(0, FULL_STOCK - count) per cell —
// exactly how many units that cell needs refilled. This module turns rows into
// an ordered checklist; delivery lives in notion.ts (page) + mailer.ts (email).
// ---------------------------------------------------------------------------

export interface RestockItem {
    color: string | null;
    style_code: string | null;
    waist: number;
    inseam: number; // length
    refill: number; // units to restock
}

// Build a sorted checklist from arbitrary rows. `getRefill` adapts to the
// caller: the confirm flow passes raw counts (FULL_STOCK - count), while a
// resend from stored Silver would pass the stored difference straight through.
// Zero-refill rows are dropped. Ordered by color → waist (shortest→longest) →
// inseam.
export function buildRestockList<T extends {
    color: string | null;
    style_code: string | null;
    waist: number;
    inseam: number;
}>(rows: T[], getRefill: (row: T) => number): RestockItem[] {
    const items: RestockItem[] = [];
    for (const r of rows) {
        const refill = Math.max(0, Math.floor(getRefill(r)));
        if (refill <= 0) continue;
        items.push({
            color: r.color,
            style_code: r.style_code,
            waist: Number(r.waist),
            inseam: Number(r.inseam),
            refill,
        });
    }

    items.sort((a, b) => {
        const c = (a.color ?? "").localeCompare(b.color ?? "");
        if (c !== 0) return c;
        if (a.waist !== b.waist) return a.waist - b.waist; // shortest waist first
        return a.inseam - b.inseam; // then shortest inseam
    });

    return items;
}
