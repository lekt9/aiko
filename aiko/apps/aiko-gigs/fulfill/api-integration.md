# API Integration — Fulfillment Playbook

Connect Service A to Service B. Build middleware. Deploy.

## Input
- `service_a`: source service + auth method
- `service_b`: target service + auth method
- `sync_direction`: A→B | B→A | bidirectional
- `sync_frequency`: real-time (webhook) | scheduled (cron) | one-time
- `data_mapping`: field mappings, transformations

## Stack Preference

```
Default: Cloudflare Workers (TypeScript)
  - Free tier covers most gigs
  - Global edge, low latency
  - Secrets via wrangler secrets
  - Cron triggers for scheduled syncs

Alternative: Rust binary (for CPU-heavy transforms)
Alternative: Python script (for data-heavy ETL)
```

## Phases

### 1. Auth Setup
```
- Read both services' API docs
- Determine auth method (OAuth2, API key, Basic)
- Set up credentials (never hardcode — use env vars or secrets manager)
- Test auth with a simple ping/health check call
```

### 2. Build Integration
```
1. Read data from source (paginated if needed)
2. Transform fields per mapping spec
3. Write to target (batch or stream)
4. Handle errors:
   - Source unavailable → retry with backoff
   - Target rejects → log, skip, continue
   - Rate limit → throttle, queue
5. Idempotency: deduplicate by source ID
```

### 3. Deploy
```
Cloudflare Workers:
  wrangler deploy
  wrangler secret put SOURCE_API_KEY
  wrangler secret put TARGET_API_KEY

Scheduled:
  wrangler cron schedule "*/15 * * * *"  # every 15 min

Webhook:
  Expose endpoint, validate incoming webhook signature
```

### 4. Verify
```
- Run a test sync with 10 records
- Verify all fields mapped correctly
- Check error handling (disconnect source, verify graceful degradation)
- Verify idempotency (run twice, no duplicates)
```

### 5. Deliver
- Deployed worker URL (or repo if self-hosted)
- README: setup, env vars, how to modify mapping
- Test results (before/after for sample records)
- Monitoring: Cloudflare dashboard or custom health check

## Verification
```bash
# Test the deployed worker
curl -s https://your-worker.workers.dev/health | jq .

# Trigger a sync and check results
curl -s -X POST https://your-worker.workers.dev/sync | jq '.synced_count'
```
