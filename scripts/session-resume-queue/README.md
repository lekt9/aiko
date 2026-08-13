# session-resume-queue

Memory-gated resume of crashed Claude / Codex / Prime Agent sessions
on the Steam Deck. One job at a time. Does not start unless the host
has real headroom. Children run inside systemd user scopes with RAM
and swap caps so a resume cannot refill swap.

This complements `prime-ram-sandbox` (per-session cgroup freeze/thaw).
The sandbox keeps a *running* Prime Agent from killing the host.
This queue decides *whether* a crashed session is allowed to start
again.

## Resume recipes (proven CLI)

```bash
# Claude Code — skip permission prompts, non-interactive
claude --resume "$ID" --dangerously-skip-permissions -p "$CONTINUE"

# Codex — yolo is the global alias for bypass-approvals-and-sandbox
codex --yolo -C "$CWD" exec resume "$ID" "$CONTINUE"

# Prime Agent — PATH wrapper already attaches the RAM sandbox
prime-agent --resume "$ID" --cwd "$CWD" -p "$CONTINUE" --autonomous
```

`$CONTINUE` is a short “you were interrupted, finish the original
task” prompt. The session transcript is the source of the original
goal; we do not invent a new one.

## Memory budget (parallel, up to 80% RAM)

The dispatcher **fills parallel slots** until host use would exceed
`SRQ_RAM_RATIO` (default **0.80** of `MemTotal`). On a 31 GiB deck that
is ~8 concurrent resumes at 3 GiB each.

| Knob | Default | Role |
|---|---|---|
| `SRQ_RAM_RATIO` | `0.80` | max host RAM fraction the queue may occupy |
| `SRQ_SESSION_BYTES` | 3 GiB | per-job `MemoryMax` |
| `SRQ_SESSION_SWAP_BYTES` | 512 MiB | per-job `MemorySwapMax` |
| `SRQ_MAX_SWAP_RATIO` | `0.90` | hard stop on opening *new* slots |
| `SRQ_MAX_LOAD_FACTOR` | `2.0` | soft brake: no new slots if load1 > nproc×this |

Always leaves ~2 GiB free. Existing scopes keep running when the soft
load brake is red; only *new* launches pause.

## Layout

| Path | Role |
|---|---|
| `inventory.py` | last-7-day crash scan (tail-only, cheap) |
| `queue.py` | durable JSONL queue |
| `dispatch.py` | memory-gated worker |
| `witness.py` | end-to-end gate (exit 0 when armed + no leaked crashes) |
| `install.sh` | install systemd user unit on the deck |

State lives in `~/.local/state/session-resume-queue/` (not in git).
