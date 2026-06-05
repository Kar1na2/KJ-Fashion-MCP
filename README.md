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

Database: 
- time-series-oriented columnar setup
    - We are doing Append-only adding in new snapshot each day 
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