CREATE TABLE IF NOT EXISTS bronze_scans (
    scan_id     VARCHAR PRIMARY KEY,
    source_image VARCHAR NOT NULL,
    ingested_at     TIMESTAMP DEFAULT now(),
    status      VARCHAR DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS silver_inventory (
    scan_id       VARCHAR NOT NULL,          -- which scan this came from (links to bronze)
    sheet_date    DATE,                       -- Sunday the week started (counted the following Saturday)
    fashion_line  VARCHAR,                    -- K.J. / L.B. / null
    style_code    VARCHAR,                    -- e.g. '5141325'
    color         VARCHAR,                    -- e.g. 'D. Blue'
    waist         INTEGER NOT NULL,           -- 30 or 32
    inseam        INTEGER NOT NULL,           -- 30..60
    quantity      INTEGER NOT NULL,           -- weekly difference: max(0, 3 - counted), units sold/used
    confidence    DOUBLE,                     -- 1.0 once human-confirmed
    PRIMARY KEY (scan_id, style_code, color, waist, inseam)
);

CREATE OR REPLACE VIEW gold_monthly as
SELECT
    -- sheet_date is the week-start Sunday; a week belongs to the month of its
    -- count Saturday (sheet_date + 6 days), so a week whose Sunday is in the
    -- previous month still rolls up into the month it was counted in.
    date_trunc('month', sheet_date + INTERVAL 6 DAY) as month,
    fashion_line,
    style_code,
    color,
    waist,
    SUM(quantity)   as total_qty,
    COUNT(DISTINCT sheet_date)  as weeks_counted
FROM silver_inventory
WHERE sheet_date IS NOT NULL
GROUP BY 1, 2, 3, 4, 5;