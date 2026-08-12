---
name: telegram-contracts
description: "Wrap Telegram Bot API observations and actions as contract-native capability graphs. Use for Telegram bots, message watchers, pairing, notifications, replies, media, callbacks, or durable rules such as 'tell me when this person messages'. Keep Telegram outside the core runtime: create event contracts first, expand them into bounded parallel child contracts, and gate message-sending effects on explicit authorization."
---

# Telegram contracts

Treat Telegram as an API capability pack, not an Aiko subsystem. Use the generic
Contract ledger, scheduler, child lineage, parallel waves, and isolated Aiko
workers. Keep the bot token in the local environment or keychain; never place it
in a contract, prompt, proof, log, or shared descriptor.

## Build the graph

1. Declare every inbound update before filtering it. Store update id, chat/user
   identity, message kind, and a redacted summary. This observation is allowed
   even when the sender is not paired.
2. Create sibling children for identity resolution, durable logging, rule
   matching, and content/media normalization. Run independent read-only children
   in one bounded parallel wave.
3. Create effect children such as `sendMessage`, `sendVoice`, or file delivery
   only after rule matching. Make them depend on an authorization child.
4. If authorization is absent, retain the event as `pending_authorization` and
   continue safe children. Do not discard the event and do not bypass the gate.
5. Ground the parent only from child outcomes. A successful HTTP request proves
   that child, not the entire watcher or user goal.
6. Let each runnable leaf execute as a fresh headless Aiko process. Pass lineage
   with `AIKO_CONTRACT_PARENT_ID`; use Contract as the shared durable state.

For a deterministic graph skeleton, run:

```bash
python3 scripts/build_contract_pack.py watch-message \
  --person "Alethea" --notify-owner
```

Register the generated capabilities using the host's native Contract catalog.
Do not add Telegram endpoint branches to the generic daemon.

## Event shape

Use this privacy-safe minimum:

```json
{
  "source": "telegram",
  "update_id": 291764682,
  "actor_id": 489698073,
  "kind": "message",
  "authorization": "approved | pending_authorization | denied",
  "summary": "Yo aiko"
}
```

Truncate summaries and exclude tokens, downloaded media bytes, contact details,
and arbitrary API response bodies. Read [references/telegram-api.md](references/telegram-api.md)
when selecting endpoint contracts. Use [assets/capabilities.json](assets/capabilities.json)
as the capability descriptor template.

## Execution rules

- Polling/webhook receipt is a network-read contract.
- Sending, editing, deleting, reacting, and answering callbacks are network-write
  contracts and require their declared permission.
- Pairing creates an identity/authorization contract; it is not a special bridge
  code path.
- A watcher is a durable scheduled/event contract. It may preempt many updates,
  and every update may expand into many children.
- Cap fan-out at 16 children per wave and preserve dependency barriers.
- Retry Telegram rate limits and transient failures through Contract settlement;
  never mark the parent satisfied before dependent effects are observed.
