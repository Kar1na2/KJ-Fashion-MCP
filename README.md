# KJ-Fashion-MCP
MCP Server for KJ Fashion

## Context 

I want to help KJ Fashion with their outdated inventory issue. 

There will be two things going on here 

`Client (Claude App, Gemini) -> MCP Server -> Database (Inventory lists)`

and 

`Employee writes an inventory list -> sends to Database` 

Some things to note on here 
Code language used: 
- TypeScript 
- SQL

Cadence:
- Inventory is **counted every Saturday** and **refilled every Sunday** back to the full baseline (3 per cell).
- Intake dates are guaranteed to be a Saturday: a non-Saturday is rejected as invalid (no silent auto-correction), and the date is chosen from a calendar picker.
- A week is a separate, non-overlapping span that **begins Sunday** (assumed full) and **ends the following Saturday** (count taken → units sold computed). It is stored keyed by its Sunday: a sheet counted Sat `2026-06-13` is the week of Sun `2026-06-07`. A weekly query for that week runs from its Sunday `2026-06-07` to its Saturday `2026-06-13`.
- Silver does not store the raw count — it stores the **weekly difference** `max(0, 3 - count)`, i.e. the units sold/used that week.
- **Monthly** rollups assign a week to the month of its **count Saturday** (`sheet_date + 6 days`), so a week whose Sunday is still in the previous month is included in the month it was counted in.

Database: 
- time-series-oriented columnar setup
    - We are doing Append-only adding in new snapshot each week (Saturday) 
    - Time-stamped and queried by time ranges helps with inventory analytics 
    - OLAP over OLTP since we're doing batch processing rather than stream and we need a multidimensional data model with the many attributes that we have

I'll primarily be using DuckDB over Clickhouse or Apache Druid simply because of how little the scale will be 

To ensure ACID and handling of the files I'll be using the medallion architecture 
Scanned image → object storage (Bronze)
   → OCR / vision extraction → validation
   → normalized rows inserted (Silver, partitioned by month)
   → materialized view auto-updates monthly rollups (Gold)
MCP query tool → hits Gold aggregates → returns trend

Vite will also be my frontend just because of it's simplicity in setting up and fast deployment

## Things being done and how

- change so that it is no longer daily, input will be done on every SATURDAY, refill on every SUNDAY 
    - Remove the tool to track daily 
    - Set so that the date is guaranteed to be a saturday (instead of autocorrecting, telling the user that the date is invalid) 
        - make it easier to set the date by just clicking on a calendar instead of typing out the exact date 
    - Image upload remains the same, but the storage context is different as silver will now be keeping track of the difference everything will be 3 - # 

- Viewing a list of entries from the database that shows the raw image from the bronze section for each date from db 
    - Now there will be a basic login section where I'll be providing the credentials myself for security 
        - This will lead to a homepage showing a list of rows that shows the dates stored example: "06-07-2026 -> 06-13-2026" or whatever way to put the date is easiest, each of these dates will be a link where once clicked will go to a new page that shows a clean view of the inventory sold as well as the raw picture from the bronze category that has been stored in that week 
        - next to each date will have a button to edit or delete, in case the confirmation made human errors, the person with credentials can login and make an edit to that specific date or if it's a duplicate then the person can delete it

## Things to be worked on 

- Allowing an actual MCP workflow that takes in the image every Saturday and automatically compiles a list and sends it as a checklist for refills