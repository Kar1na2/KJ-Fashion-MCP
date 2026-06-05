CREATE TABLE IF NOT EXISTS bronze_scans (
    scan_id     VARCHAR PRIMARY KEY,
    source_image VARCHAR NOT NULL,
    ingested_at     TIMESTAMP DEFAULT now(),
    status      VARCHAR DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS silver_inventory (
    scan_id       VARCHAR NOT NULL,          -- which scan this came from (links to bronze)
    sheet_date    DATE,                       -- date on the sheet (may be null)
    fashion_line  VARCHAR,                    -- K.J. / L.B. / null
    style_code    VARCHAR,                    -- e.g. '5141325'
    color         VARCHAR,                    -- e.g. 'D. Blue'
    waist         INTEGER NOT NULL,           -- 30 or 32
    inseam        INTEGER NOT NULL,           -- 30..60
    quantity      INTEGER NOT NULL,           -- Ø stored as 0
    confidence    DOUBLE,                     -- 1.0 once human-confirmed
    PRIMARY KEY (scan_id, style_code, color, waist, inseam)
);

CREATE OR REPLACE VIEW gold_monthly as
SELECT 
    date_trunc('month', sheet_date) as month,
    fashion_line,
    style_code,
    color,
    waist,
    SUM(quantity)   as total_qty,
    COUNT(DISTINCT sheet_date)  as days_counted
FROM silver_inventory
WHERE sheet_date IS NOT NULL
GROUP BY 1, 2, 3, 4, 5;