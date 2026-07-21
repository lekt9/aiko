# Data Extraction — Fulfillment Playbook

PDF, image, screenshot → structured data (CSV/JSON).

## Input
- `source_type`: pdf | image | screenshot | html_table
- `source_files`: list of file paths or URLs
- `extraction_schema`: fields + types
- `volume`: number of documents

## Phases

### 1. Source Analysis
- PDF: check if text-based (extractable) or scanned (needs OCR)
- Image: resolution, text density, table vs freeform
- Screenshot: same as image, check for data tables

### 2. Extraction
```
PDF (text-based):
  → Python pdfplumber or pdftotext
  → Parse structured fields with regex or layout analysis

PDF (scanned) or Image:
  → macOS Vision framework for OCR (swift)
  → Or Tesseract via Python
  → Post-process OCR output for common errors

HTML table:
  → unbrowse + CSS selector extraction
  → pandas read_html
```

### 3. Validation
- Row count matches document count × expected rows per doc
- Required fields present
- Numeric fields parse correctly
- Dates are valid and consistent format
- Spot check 5% of rows against source documents

### 4. Deliver
- Extracted data file
- Extraction script (reproducible)
- Error log (documents that failed, with reasons)
- Validation report

## Verification
```bash
python3 -c "
import csv, json
with open('output.csv') as f:
    rows = list(csv.DictReader(f))
print(f'Rows: {len(rows)}')
for field in rows[0].keys():
    filled = sum(1 for r in rows if r[field].strip())
    print(f'  {field}: {filled}/{len(rows)}')
"
```
