#!/usr/bin/env python3
"""Pipeline watcher — polls remote L40S logs, DMs Lewis on milestones + errors,
auto-kills remote process on FAIL-FAST patterns and DMs the failure mode.

Usage:
  pipeline-watcher.py --stage v14-train --log-path /home/lekt9/.../v14_train.log \
    --remote-pgrep 'train_v12_sft.*v14_talker' \
    --milestones 'checkpoint-50,checkpoint-100,checkpoint-150,checkpoint-200,train_loss=' \
    --errors 'Traceback,FAIL FAST,CUDA out of memory,OutOfMemoryError,RuntimeError' \
    --interval 60 --to lewis

  --to is the Telegram identity to DM (resolved to @cayden27 or @l_wis-as-self via Σ3).
  Default --to=self → DMs Lewis on his own @l_wis account (saved messages or self-DM).

States persist at ~/.contracts/inbox/watcher/<stage>.jsonl (rows: milestone, error, done).
"""
import asyncio, argparse, pathlib, json, subprocess, time, sys, os, re

API_ID_F = pathlib.Path.home() / ".config" / "telegram" / "api_id"
API_HASH_F = pathlib.Path.home() / ".config" / "telegram" / "api_hash"
SESSION = "/tmp/lewis_user"


def remote_cmd(host_user_ip, cmd):
    r = subprocess.run(
        ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host_user_ip, cmd],
        capture_output=True, text=True, timeout=30,
    )
    return r.returncode, r.stdout, r.stderr


async def send_dm(client, to_handle, text):
    target = await client.get_entity(to_handle)
    await client.send_message(target, text)


def append_event(stage, kind, payload):
    p = pathlib.Path.home() / ".contracts" / "inbox" / "watcher" / f"{stage}.jsonl"
    p.parent.mkdir(parents=True, exist_ok=True)
    row = {"stage": stage, "kind": kind, "ts": time.time(), "ts_iso": time.strftime("%FT%TZ", time.gmtime()), **payload}
    with p.open("a") as f:
        f.write(json.dumps(row) + "\n")
    return row


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", required=True, help="label for the watcher (v14-train, stage5-quantize, etc)")
    ap.add_argument("--log-path", required=True, help="absolute remote path to the log")
    ap.add_argument("--remote-pgrep", required=True, help="pgrep -f pattern to detect process alive on remote")
    ap.add_argument("--milestones", default="", help="comma-separated substrings to DM on first sighting")
    ap.add_argument("--errors", default="Traceback,FAIL FAST,CUDA out of memory,OutOfMemoryError,RuntimeError", help="comma-separated FAIL FAST markers — first sighting kills remote + DMs")
    ap.add_argument("--remote-kill", default="", help="optional remote command to kill on error (e.g. 'pkill -f pattern'); defaults to pkill on --remote-pgrep pattern")
    ap.add_argument("--interval", type=int, default=60, help="poll interval seconds (default 60)")
    ap.add_argument("--max-minutes", type=int, default=120, help="kill watcher after N minutes regardless (default 2h)")
    ap.add_argument("--ssh-target", default="lekt9@89.169.121.143", help="ssh user@host (default L40S)")
    ap.add_argument("--to", default="self", help="DM target: 'self' (DM saved messages on @l_wis) or telegram handle")
    args = ap.parse_args()

    from telethon import TelegramClient
    api_id = int(API_ID_F.read_text().strip())
    api_hash = API_HASH_F.read_text().strip()

    seen_milestones = set()
    milestones = [m.strip() for m in args.milestones.split(",") if m.strip()]
    errors = [e.strip() for e in args.errors.split(",") if e.strip()]
    kill_cmd = args.remote_kill or f"pkill -f '{args.remote_pgrep}' 2>/dev/null; sleep 2; pkill -9 -f '{args.remote_pgrep}' 2>/dev/null"

    deadline = time.time() + args.max_minutes * 60
    start = time.time()

    async with TelegramClient(SESSION, api_id, api_hash) as client:
        me = await client.get_me()
        to = "me" if args.to == "self" else args.to
        # DM kickoff
        kickoff = f"🚦 watcher live · stage={args.stage} · polling every {args.interval}s · max {args.max_minutes}min\nlog: {args.log_path}\nmilestones: {', '.join(milestones) or '(none — wait for process death)'}\nerrors: {', '.join(errors)}"
        await send_dm(client, to, kickoff)
        append_event(args.stage, "kickoff", {"to": to, "log": args.log_path})

        last_pos = 0
        while time.time() < deadline:
            # Check process alive
            rc_alive, _, _ = remote_cmd(args.ssh_target, f"pgrep -f '{args.remote_pgrep}' | grep -v pgrep | head -1")
            alive = rc_alive == 0

            # Pull only the NEW tail of the log since last poll
            rc, tail, _ = remote_cmd(args.ssh_target, f"tail -c +{last_pos + 1} '{args.log_path}' 2>/dev/null | head -c 50000")
            new_text = tail or ""
            if new_text:
                last_pos += len(new_text)

            # Milestone detection (first sighting only)
            for m in milestones:
                if m in new_text and m not in seen_milestones:
                    seen_milestones.add(m)
                    elapsed = int(time.time() - start)
                    msg = f"✅ {args.stage} · milestone {m!r} hit at {elapsed//60}m{elapsed%60:02d}s"
                    await send_dm(client, to, msg)
                    append_event(args.stage, "milestone", {"marker": m, "elapsed_s": elapsed})

            # Error detection — first sighting kills + DMs + exits
            for e in errors:
                if e in new_text:
                    elapsed = int(time.time() - start)
                    # Grab last ~25 lines for context
                    _, ctx, _ = remote_cmd(args.ssh_target, f"tail -25 '{args.log_path}'")
                    msg = f"❌ {args.stage} · ERROR detected ({e!r}) at {elapsed//60}m{elapsed%60:02d}s · killing remote process\n\nlog tail:\n{ctx[-3000:]}"
                    await send_dm(client, to, msg)
                    remote_cmd(args.ssh_target, kill_cmd)
                    append_event(args.stage, "error", {"marker": e, "elapsed_s": elapsed, "log_tail": ctx[-2000:]})
                    await send_dm(client, to, f"🛑 {args.stage} · killed remote process · watcher exiting")
                    return 1

            # Process death without error means success or silent exit
            if not alive:
                elapsed = int(time.time() - start)
                _, ctx, _ = remote_cmd(args.ssh_target, f"tail -15 '{args.log_path}'")
                msg = f"🏁 {args.stage} · remote process exited at {elapsed//60}m{elapsed%60:02d}s\n\nlog tail:\n{ctx[-2500:]}"
                await send_dm(client, to, msg)
                append_event(args.stage, "done", {"elapsed_s": elapsed, "log_tail": ctx[-2000:]})
                return 0

            await asyncio.sleep(args.interval)

        # Timeout
        msg = f"⏰ {args.stage} · watcher timeout after {args.max_minutes}min · process still alive"
        await send_dm(client, to, msg)
        append_event(args.stage, "timeout", {"max_minutes": args.max_minutes})
        return 2


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
