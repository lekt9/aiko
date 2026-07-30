# Web Scraping — Fulfillment Playbook

How Aiko completes a web scraping gig end-to-end.

## Input (from gig brief)

- `target_urls`: list of URLs or a base URL + pagination pattern
- `data_schema`: fields to extract (e.g., title, price, description, image_url)
- `output_format`: CSV, JSON, or SQL
- `page_count`: estimated number of pages/products
- `special_requirements`: login, JS rendering, anti-bot, schedule

## Phase 1: Site Analysis

```
1. Load a sample page via unbrowse
2. Identify:
   - Page structure (static HTML vs SPA vs hybrid)
   - Data location (DOM selectors, API calls, embedded JSON)
   - Pagination mechanism (URL params, infinite scroll, "load more" button)
   - Anti-bot measures (Cloudflare, captcha, rate limiting, UA checks)
3. If API calls visible: prefer Voyager/GraphQL/JSON API over DOM scraping
4. Test extraction on 3–5 sample pages
5. Validate extracted data against visible page content
```

## Phase 2: Build Scraper

```
Tool selection:
  - Static HTML + simple pagination → unbrowse resolve + execute (cached, fast)
  - SPA / JS-heavy → unbrowse go + snap + extract (browser render)
  - Anti-bot heavy → unbrowse CDP with cookie import + stealth flags
  - API-first → reverse-engineer the internal API via network capture
  - Massive scale (>10k pages) → parallelize with stateless CDP primitives

Build in order:
  1. Single page extraction (validate schema)
  2. Pagination handling
  3. Error recovery (retry on failure, skip on permanent error)
  4. Rate limiting (respect robots.txt, add delays)
  5. Resume support (save progress, restart from last successful page)
  6. Output formatting (CSV with headers, JSON array, SQL inserts)
```

## Phase 3: Execute

```
1. Dry run: 10 pages, validate output
2. Full run with progress tracking
3. Post-extraction validation:
   - Row count matches expected page count
   - No empty required fields
   - Data types match schema (prices are numbers, URLs are valid)
   - No duplicate rows
4. Generate summary: pages scraped, rows extracted, failures (if any)
```

## Phase 4: Package & Deliver

```
Deliverable checklist:
  [ ] Scraper source code (well-commented, with README)
  [ ] Extracted data file (CSV/JSON)
  [ ] README: how to run, modify field selectors, handle errors
  [ ] Validation summary: row count, field completeness, sample rows
  [ ] If scheduled: crontab or contract schedule entry
  [ ] If API delivery: webhook URL or API endpoint
```

## Verification (Before Marking Done)

```bash
# Row count
wc -l output.csv

# Field completeness (example for CSV)
python3 -c "
import csv
with open('output.csv') as f:
    reader = csv.DictReader(f)
    rows = list(reader)
    total = len(rows)
    for field in reader.fieldnames:
        filled = sum(1 for r in rows if r.get(field, '').strip())
        print(f'{field}: {filled}/{total} ({filled/total*100:.1f}%)')
"

# Spot check: compare 5 random rows against live page
```

## Edge Cases to Handle

| Scenario | Handling |
|----------|----------|
| Page returns 403/429 | Exponential backoff, rotate UA, use cookie import |
| Infinite scroll | Scroll-to-bottom loop with duplicate detection |
| Login wall | Use unbrowse auth-capture or client-provided credentials |
| Dynamic IDs/classes | Use structural selectors (nth-child, data attributes) |
| Rate limit | Add random delays (2–5s between requests) |
| Partial data (some fields missing) | Log and skip row, don't fail entire job |
| Encoding issues | Detect and convert (UTF-8, Latin-1, etc.) |
| Large output (>100MB) | Split into multiple files or stream to database |
