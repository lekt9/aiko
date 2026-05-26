# openai-compat-mapping-v1

Canonical mapping from the OpenAI Chat Completions wire shape to the
`/contract` substrate. This document IS the `plan` text of the
parent /contract declared at install time (see
`scripts/declare-openai-compat-mapping.sh`); each translation rule
below is also a child /contract whose own `plan` carries the rule
text and whose `action` names the substrate primitive it binds.

The wrapper in the `contract-openai-api` sibling repo reads this
mapping at startup, applies it on every request, and emits OpenAI-
shaped JSON. There is no logic in the wrapper that is not encoded
here as a child /contract — the wrapper is a walker, not a translator.

## Invariants

1. **One conversation = one root /contract.** The HTTP request body
   `{messages: [...], tools: [...]}` materializes as a DAG: one root
   row whose plan is the system message, every subsequent message a
   child or iterated row.
2. **Every message is signed.** The lineage chain follows existing
   `parent_signature` semantics — the conversation root signs its
   children, the children sign their tool-call grandchildren, etc.
3. **Tool catalog = published-skill surface.** `tools[]` is derived
   from published /contracts at request time. Absent in the request
   body → ALL published contracts surfaced (subject to a future
   `tool_visibility:public` synapse filter; see rule R8).
4. **Final response is the L7→L8 cascade.** When the conversation's
   terminal `markSatisfied` fires, the existing pattern automatically
   spawns the `validate:` (L7) row and `signed:` (L8) pointer-memory.
   The wrapper reads the signed row's signature as the response
   `id`/`fingerprint`.

## Translation rules (each is a child /contract)

### R1 — root: system message → root /contract

```
parent_id   = <truth-root or session-anchor>
plan        = messages[0].content  (if role=="system"; else "")
action      = "neuron:openai-session"
extras      = {api: "openai", schema_version: "v1"}
```

If the first message is not `system`, the root /contract still
exists but with an empty plan. The wrapper records `agent` = the
calling client id (from `Authorization` bearer or `OpenAI-User-Id`
header), so multi-tenant isolation rides the existing `agent` field.

### R2 — user message → declared child

```
parent_id   = <conversation-root id>
plan        = message.content
action      = "neuron:user"
extras      = {role: "user", msg_index: N}
```

If `content` is an array (multimodal), each block becomes its own
declared sibling under the message /contract, with `action` reflecting
the block type (`modality:text`, `modality:image`, etc.) — already
covered by the layer-4 `modality:` shape in `pointer.zig`.

### R3 — assistant text reply → iterated row on conversation root

The assistant's text content is emitted as a `recordIteration` event
on the conversation root, NOT as a new declared row. Rationale: the
conversation is one truth claim ("answer the user"), assistant turns
are iterations toward that claim.

```
recordIteration:
  id     = <conversation-root id>
  wave   = N+1 (one wave per assistant turn)
  output = message.content (text)
extras   = {role: "assistant", reasoning_content: ?}
```

### R4 — assistant reasoning / thinking → evidence row

The `reasoning_content` field (or `<thinking>` blocks if the model
emits them) lands as an `appendEvidenceRow` on the conversation root.
This keeps the thinking visible in the ledger walk for debugging
without polluting the iteration text.

```
appendEvidenceRow:
  id            = <conversation-root id>
  wave          = N+1
  evidence_kind = "thinking"
  payload       = reasoning_content
```

### R5 — tool_call → declared child per call

Each entry in `message.tool_calls[]` becomes a fresh declared
/contract, child of the conversation root.

```
parent_id   = <conversation-root id>
plan        = tool_call.function.name + ": " + tool_call.function.arguments
action      = <resolved action — see below>
extras      = {role: "tool_call", tool_call_id: tool_call.id}
```

Action resolution: look up the tool's published /contract by name.
The published row's `action` field gets copied verbatim, with
templated `{arguments}` substitution. This routes the call through
the right layer — `cli:` (layer 2), `api:` (layer 2), `webhook:`
(layer 4), `wallet:` (layer 5), `contract:<id>` (layer 3, calls
another /contract), etc.

### R6 — tool response → satisfied on the tool-call /contract

When the client returns the tool result message (role="tool"), the
wrapper looks up the tool-call /contract by `tool_call_id`, then:

```
markSatisfied:
  id    = <tool-call /contract id>
  wave  = 1
  proof = message.content (the tool result)
```

The L7→L8 cascade fires here only if the tool /contract was
declared at layer 7 (validators). Standard tools (layer 2/4) land
their `satisfied` row + their `signed:` child if at layer 7.

### R7 — final assistant message → markSatisfied on the root

When the model returns a final assistant message WITHOUT
`tool_calls`, the wrapper treats that as conversation resolution:

```
markSatisfied:
  id    = <conversation-root id>
  wave  = N+1
  proof = final_message.content
```

The auto-cascade then spawns `validate:<root_id>` (layer 7) and its
`signed:<sig>` pointer-memory (layer 8). The `signed` row's
`signature` becomes the response's `id` field on the wire (prefixed
with `chatcmpl-`).

### R8 — tool catalog = published contracts (filtered)

At request time the wrapper queries `aiko list --published` and
surfaces every row carrying a `tool_visibility:public` synapse as
an OpenAI tool definition:

```
tools[i] = {
  type: "function",
  function: {
    name:        published.plan_slug,
    description: published.plan,
    parameters:  published.extras.agent_params_schema,
  }
}
```

Published contracts without `tool_visibility:public` are
invisible to the model — they exist but can't be tool-called.
This is the permission boundary between "published" and "exposed".

If the request body includes an explicit `tools` list, the wrapper
narrows the catalog to only the named tools (intersection).

## Bootstrap

This mapping /contract is declared once by
`scripts/declare-openai-compat-mapping.sh`. The script:

1. `aiko declare "openai-compat-mapping-v1: $(cat THIS_FILE)" "neuron:mapping-spec"`
2. Captures the returned root id as `MAPPING_ID`
3. For each rule R1..R8: `aiko declare "<rule-plan>" "<rule-action>" --parent "$MAPPING_ID"`
4. Writes resulting ids to `.contract-openai-mapping-ids.jsonl` for the
   wrapper to consume

The wrapper reads `.contract-openai-mapping-ids.jsonl` at startup,
walks each rule /contract to read its current action, applies them
in order. Re-declaring the mapping = bumping the version (a new
parent /contract with v2 plan; sibling repos pin to a specific id).

## Versioning

`openai-compat-mapping-v1` is the canonical mapping for OpenAI's
2026-era Chat Completions API (messages/tool_calls/reasoning_content).
When OpenAI evolves (Responses API supplants Chat Completions, or
a new tool shape lands), declare `openai-compat-mapping-v2` as a
sibling root /contract; sibling repos pick which version they pin
to by id, not by name. The append-only ledger means v1 never breaks
even as v2 lands.

## What is NOT in this mapping

- **Streaming.** SSE token streaming is a transport concern handled
  by the wrapper itself; the mapping describes only the message-level
  semantics. The wrapper can stream tokens while the iteration row
  builds up — final row append happens on stream close.
- **Embeddings, audio, image gen.** This mapping covers chat
  completions only. Each sister API gets its own mapping /contract
  if/when wired (`openai-embeddings-mapping-v1`, etc.).
- **Function-calling parallel modes.** The mapping assumes one
  tool_call per iteration; multi-tool-call iterations decompose to
  multiple R5 rows (siblings).
