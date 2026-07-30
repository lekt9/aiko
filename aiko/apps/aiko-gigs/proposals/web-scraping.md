# Web Scraping — Proposal Template

Use this template when bidding on web scraping / data extraction gigs.
Fill `{{PLACEHOLDERS}}` from the job description.

---

## Proposal

Hi {{CLIENT_NAME}},

I can build this scraper for you. Here's my approach:

**What I'll deliver:**
- A working scraper that extracts {{DATA_FIELDS}} from {{TARGET_SITE}}
- Output in {{FORMAT}} (CSV, JSON, or your preferred format)
- Handles pagination, rate limiting, and {{EDGE_CASES}} if applicable
- Source code included, well-documented, ready for you to modify

**Timeline:** {{TIMELINE}} (typically 24–48 hours for <500 pages)

**Price:** ${{PRICE}} (fixed price, no surprises)

**My approach:**
1. Analyze the target site's structure and anti-bot measures
2. Build the scraper with proper error handling and retries
3. Test on a sample before full run
4. Run full extraction, validate output
5. Deliver with documentation

**Why me:**
- I specialize in web scraping and data extraction
- Every project includes source code, docs, and validation
- I handle anti-bot measures, dynamic content, and complex pagination

Questions:
- {{CLARIFYING_QUESTIONS}} (e.g., "Do you need the scraper to run on a schedule, or is this a one-time extraction?")
- "Any specific data fields I should prioritize?"

Happy to do a quick test extraction on a sample page before we start.

Best,
Aiko Automation

---

## Pricing Formula

```
Base price = (number of pages / 100) × $50
Complexity multipliers:
  - Static HTML: 1.0×
  - JavaScript-rendered (SPA): 2.0×
  - Login required: 1.5×
  - Anti-bot (Cloudflare, etc.): 1.5×
  - Pagination/infinite scroll: 1.3×
  - Multiple sites: 1.2× per additional site
  - Scheduled/ongoing: 1.5× (includes monitoring)

Minimum: $150
Maximum: Cap at $5,000 for initial bid (can negotiate up for truly massive jobs)
```

## Red Flags (Don't Bid)

- Client wants the scraper to violate ToS explicitly ("bypass their security")
- Client wants to scrape PII (personal data) without consent
- Client asks for "unlimited revisions" with no scope
- Client has 0 history and asks for free sample work
- Client's budget is <$50 for >100 pages of scraping
- Job post is vague ("scrape some websites" with no details)

## Green Flags (Bid Aggressively)

- Clear, specific requirements (URLs, fields, format)
- Client has history of hiring and paying
- Budget is stated and reasonable
- "Ongoing work" or "potential for more" in description
- Client responds to clarifying questions
