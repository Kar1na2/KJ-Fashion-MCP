export interface InventoryCell {
    style_code: string | null;
    color: string | null;
    waist: number;
    inseam: number;
    quantity: number;
    confidence: number;
}

export interface ExtractionResult {
    sheet_date: string | null;
    fashion_line: string | null;
    operator: string | null;
    cells: InventoryCell[];
    notes: string | null;
}

export interface ConfirmRequest {
    scan_id: string;
    sheet_date: string | null;
    fashion_line: string | null;
    operator: string | null;
    cells: InventoryCell[];
}