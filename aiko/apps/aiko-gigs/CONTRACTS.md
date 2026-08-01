# Aiko Gigs — Contract Tree

Each node is a contract task registered via `contract task begin --check`.  
The check command is a real shell command that the ledger re-runs to verify  
completion. No LLM judgment alone — every node gates on real evidence.

**Working surface:** `contract task begin "<task>" --check "<command>"`  
**Verify:** `contract task verify <id>`  
**Do NOT use `contract declare`** — it triggers a full resolver pass on stale  
legacy rows (175+ in this repo) and will loop indefinitely.

## Root — `be4229e7` ✓

```
gigs:root
  └─ Pipeline: find automatable freelance gigs → bid → fulfill → collect
  └─ Check: all artifact files exist under apps/aiko-gigs/
```

## Platform Presence — all ✓

| Task | ID | Check |
|------|----|-------|
| Contra | `aa7ef536` | `profiles/contra.md` exists |
| Upwork | `80ecf8da` | `profiles/upwork.md` exists |
| Fiverr | `ed8444de` | `profiles/fiverr.md` exists |

## Gig Categories — verified ✓

| Category | Task ID | Check |
|----------|---------|-------|
| Web scraping | `f2ef98bd` | `fulfill/web-scraping.md` exists |
| Data extraction | `11a9a7d9` | `fulfill/data-extraction.md` exists |
| API integration | `98ddfaf0` | `fulfill/api-integration.md` exists |
| Browser automation | `gigs:category:browser-automation` (pending) | `fulfill/browser-automation.md` |
| Automated testing | `gigs:category:automated-testing` (pending) | `fulfill/automated-testing.md` |
| Code migration | `gigs:category:code-migration` (pending) | `fulfill/code-migration.md` |
| Content generation | `gigs:category:content-generation` (pending) | `fulfill/content-generation.md` |
| Email automation | `gigs:category:email-automation` (pending) | `fulfill/email-automation.md` |

## Gig Lifecycle (dynamic — registered per gig)

Each live gig creates four tasks:

```
gigs:search:{platform}:{category}
  └─ Check: unbrowse returns ≥1 matching gig listing
  └─ Gate: human reviews and picks which to bid on

gigs:bid:{platform}:{gig_id}
  └─ Check: proposal file saved and bid URL confirmed via unbrowse/CDP
  └─ Gate: human approves bid before submission

gigs:fulfill:{platform}:{gig_id}
  └─ Check: deliverable file exists AND passes spec validation script
  └─ Gate: human reviews output before delivery

gigs:settle:{platform}:{gig_id}
  └─ Check: payment confirmation screenshot exists OR platform API confirms paid
  └─ Gate: algorithm: all — verify payment received
```

## Working recipe

```bash
# Register a new task
contract task begin "gigs:search:contra:web-scraping" \
  --check "unbrowse resolve 'contra.com search web scraping jobs' | jq -e '.gigs | length > 0'"

# After work is done, verify
contract task verify <id>

# Check status of all tasks
contract status
```

## Verification

Every contract node verifies with real evidence:
- **Search**: actual job listings returned, not fabricated
- **Bid**: proposal text saved, bid URL confirmed
- **Fulfill**: deliverable file exists, passes spec check
- **Settle**: payment confirmation (screenshot or API)

Never claim success from LLM judgment alone.
