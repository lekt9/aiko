"""Evidence-based Telegram/host evaluator. Pure scoring: no network or credentials."""
import json
import math
import re
import statistics

TERMINALS = {"TurnCompleted", "TurnFailed", "TurnCancelled"}

def events_of(rows):
    return [r.get("event", r) for r in rows]

def turn_events(rows, turn):
    return [e for e in events_of(rows) if e.get("turn") == turn or (e.get("type") == "MessageReceived" and e.get("id") == turn)]

def deliveries(events):
    # Explicit final sends can also have an outbox settlement: dedupe provider IDs.
    found = {}
    prepared = next((e.get("result",{}).get("text") for e in reversed(events) if e.get("type") == "AikoReplyPrepared"), None)
    for e in events:
        kind, result = e.get("type"), e.get("result") or {}
        if kind not in {"AikoDeliverySettled", "AikoTelegramActionSettled"} or result.get("status") != "delivered":
            continue
        if kind == "AikoTelegramActionSettled" and result.get("action") not in {"telegram_send","telegram_voice","telegram_screenshot"}:
            continue
        ids = result.get("providerIds") or ([result["providerId"]] if result.get("providerId") else [])
        for message_id in ids:
            key = str(message_id)
            item = {"id":key,"at":e["at"],"text":prepared if kind == "AikoDeliverySettled" else result.get("reply"),"final":kind == "AikoDeliverySettled" or result.get("final") is True}
            if key in found:
                item["at"] = min(item["at"], found[key]["at"])
                item["final"] |= found[key]["final"]
            found[key] = item
    return sorted(found.values(), key=lambda r:r["at"])

def correlate_inbound(rows, owner, text, server_sent_ms):
    matches=[]
    for e in events_of(rows):
        telegram=e.get("telegram") or {}
        if (e.get("type")=="MessageReceived" and e.get("source")=="telegram"
            and str(e.get("chat"))==str(owner) and telegram.get("sentAt")==server_sent_ms
            and telegram.get("text",telegram.get("caption"))==text):
            matches.append(e)
    return matches[0] if len(matches)==1 else None

def correlate_deliveries(events, observations, input_message_id=None):
    """Bot API IDs and user MTProto IDs occupy different namespaces.

    Join exact delivered content + server time, with reply linkage when present.
    Ambiguous candidates remain unmatched. Preserve the client arrival timestamp.
    """
    matched=[];used=set()
    for delivery in deliveries(events):
        candidates=[]
        for item in observations:
            if item.get("kind") not in {"message","edit"} or str(item['id']) in used:continue
            if item.get("reply_to") is not None and input_message_id is not None and item["reply_to"]!=input_message_id:continue
            if item.get("server_at") is not None:
                if abs(item['server_at']-delivery['at'])>30000:continue
                if not delivery.get('text') or item.get('text')!=delivery['text']:continue
            elif str(item['id'])!=delivery['id']:
                continue # Compatibility for explicit same-namespace fixtures only.
            candidates.append(item)
        if len(candidates)!=1:continue
        item=candidates[0];used.add(str(item['id']))
        matched.append({**delivery,**item,'provider_id':delivery['id'],'id':str(item['id']),'final':delivery['final']})
    return matched

def percentile(values, p):
    ordered = sorted(v for v in values if v is not None)
    return ordered[max(0, math.ceil(len(ordered)*p)-1)] if ordered else None

def score(case, rows, observations=None, end_ms=None, sent_ms=None, input_message_id=None):
    ev = events_of(rows)
    incoming = next((e for e in ev if e.get("type") == "MessageReceived"), None)
    terminal = next((e for e in reversed(ev) if e.get("type") in TERMINALS), None)
    start = sent_ms if sent_ms is not None else (incoming or {}).get("at")
    sent = deliveries(ev)
    live = observations is not None
    matched = correlate_deliveries(ev, observations, input_message_id) if live else sent
    visible = [d for d in matched if not live or d.get("text", "").strip() or d.get("media")]
    finals = [d for d in visible if d["final"]]
    final_at = max((d["at"] for d in finals), default=None)
    first_at = min((d["at"] for d in visible), default=None)
    end = final_at or end_ms or (terminal or {}).get("at")
    timeline = sorted([start] + [d["at"] for d in visible] + ([end] if end is not None else [])) if start is not None else []
    gaps = [b-a for a,b in zip(timeline,timeline[1:])]
    first_model = min((e["at"] for e in ev if e.get("type") == "ModelCalled"), default=None)
    calls = {e.get("callId"):e.get("name") for e in ev if e.get("type") == "ToolCalled"}
    tool_errors, receipts = [], []
    native = [e for e in ev if e.get("type") == "AikoCodeToolSettled"]
    for e in native:
        if e.get("succeeded") is False:
            tool_errors.append({"tool":e.get("tool"),"status":"failed","reason":"native_tool_unsuccessful"})
    for e in ev:
        if e.get("type") != "ToolReturned": continue
        r = e.get("result")
        if isinstance(r, dict):
            receipts.append(r)
            if r.get("status") in {"blocked","failed","unknown","rejected","unsupported"} or r.get("error"):
                tool_errors.append({"tool":calls.get(e.get("callId")),"kind":r.get("kind"),"status":r.get("status"),"reason":r.get("reason")})
    answer = "\n".join(d.get("text", "") for d in finals)
    if not live:
        prepared = [e.get("result",{}).get("text", "") for e in ev if e.get("type") == "AikoReplyPrepared"]
        explicit = [e.get("result",{}).get("reply", "") for e in ev if e.get("type") == "AikoTelegramActionSettled" and e.get("result",{}).get("final")]
        answer = "\n".join(t for t in prepared + explicit if isinstance(t,str))
    checks = []
    def check(name, passed, evidence):
        checks.append({"criterion":name,"passed":passed,"evidence":evidence})
    if case:
        check("visible_final_reply",bool(finals),"Matched final delivery receipt" if finals else "No matched final reply before deadline")
        for expected in case.get("contains",[]):
            check("answer_contains",expected.casefold() in answer.casefold(),expected)
        for pattern in case.get("patterns",[]):
            check("answer_pattern",bool(re.search(pattern,answer,re.I)),pattern)
        if "exact" in case:
            check("exact_answer",answer.strip() == case["exact"],case["exact"])
        if "json" in case:
            try: parsed = json.loads(answer.strip()); passed = parsed == case["json"]
            except (ValueError, TypeError): passed = False
            check("structured_answer",passed,"Exact JSON value, without fences or extra prose")
        if case.get("max_words"):
            check("word_limit",0 < len(answer.split()) <= case["max_words"],f'{len(answer.split())} words')
        if case.get("receipt_kind"):
            good = [r for r in receipts if r.get("kind") in case["receipt_kind"] and r.get("status") in {"completed","ok","delivered","processed"}]
            check("tool_evidence",bool(good),f'{len(good)} successful required receipts')
        if case.get("browser"):
            good = [r for r in receipts if r.get("kind") == "browser-receipt" and r.get("status") == "completed"]
            check("browser_evidence",bool(good),f'{len(good)} completed browser receipts')
        if case.get("compute"):
            confirmed = any(r.get("state") == "completed" and r.get("exitCode") == 0 for r in receipts)
            opaque = any(e.get("tool") == "sandbox_job" and e.get("succeeded") is True for e in native)
            check("confirmed_compute_completion",True if confirmed else None if opaque else False,
                  "Completed process, exit 0" if confirmed else "Private job receipt needs inspection" if opaque else "No successful sandbox job evidence")
        if case.get("links"):
            check("source_links",len(re.findall(r'https?://[^\s)]+',answer)) >= case["links"],"Links present; source support still needs review")
    elapsed = final_at - start if final_at is not None and start is not None else None
    first_ms = first_at - start if first_at is not None and start is not None else None
    max_gap = max(gaps,default=None)
    progress = [d for d in visible if not d["final"]]
    flags=[]
    if not finals: flags.append("no_confirmed_final_reply")
    if max_gap is not None and max_gap > 30000: flags.append("silence_over_30s")
    if elapsed is not None and elapsed > 15000 and not progress: flags.append("long_task_without_intermediate_message")
    if any(e.get("type")=="AikoReplySuppressed" for e in ev): flags.append("reply_suppressed")
    if any(e.get("result",{}).get("content")=="service_notice" for e in ev if isinstance(e.get("result"),dict)): flags.append("service_fallback")
    if terminal and terminal["type"] != "TurnCompleted": flags.append(terminal["type"])
    return {"case":case.get("id") if case else (incoming or {}).get("id"),"category":case.get("category") if case else "historical",
      "turn":(incoming or {}).get("id"),"measurement":"telegram_observed" if live else "host_receipt_only",
      "first_message_ms":first_ms,"completion_ms":elapsed,"max_silence_ms":max_gap,
      "queue_to_first_model_ms":first_model-start if first_model is not None and start is not None else None,
      "first_model_to_reply_ms":final_at-first_model if final_at is not None and first_model is not None else None,
      "intermediate_messages":len(progress),"final_messages":len(finals),"model_calls":sum(e.get("type")=="ModelCalled" for e in ev),
      "tool_calls":len(calls),"native_tool_calls":len(native),
      "prompt_tokens":sum(e.get("usage",{}).get("promptTokens",0) for e in ev if isinstance(e.get("usage"),dict)),
      "completion_tokens":sum(e.get("usage",{}).get("completionTokens",0) for e in ev if isinstance(e.get("usage"),dict)),"tool_errors":tool_errors,"terminal":(terminal or {}).get("type"),
      "checks":checks,"objective_pass":False if any(c["passed"] is False for c in checks) else None if not checks or any(c["passed"] is None for c in checks) else True,
      "needs_review":bool(case and (case.get("review") or case.get("compute") or any(c["passed"] is None for c in checks))),"ux_flags":flags,"answer":answer,
      "trace_event_count":len(ev),"delivery_ids":[d["id"] for d in sent],"client_message_ids":[d["id"] for d in matched] if live else []}

def summarize(results):
    graded = [r for r in results if r["objective_pass"] is not None]
    return {"cases":len(results),"objective_passes":sum(r["objective_pass"] for r in graded),"objectively_graded":len(graded),
      "requires_subjective_review":sum(r["needs_review"] for r in results),
      "confirmed_final_replies":sum(r["final_messages"] > 0 for r in results),
      "first_message_p50_ms":percentile([r["first_message_ms"] for r in results],.5),
      "first_message_p95_ms":percentile([r["first_message_ms"] for r in results],.95),
      "completion_p50_ms":percentile([r["completion_ms"] for r in results],.5),
      "completion_p95_ms":percentile([r["completion_ms"] for r in results],.95),
      "longest_silence_ms":max((r["max_silence_ms"] or 0 for r in results),default=0),
      "turns_with_tool_errors":sum(bool(r["tool_errors"]) for r in results),
      "silent_or_unconfirmed_turns":sum(not r["final_messages"] for r in results)}

def markdown(report):
    def sec(value): return "—" if value is None else f"{value/1000:.1f}s"
    summary=report["summary"]
    lines=["# Aiko Telegram evaluation", "", f"Mode: {report['mode']}. Seed: {report.get('seed','n/a')}. Deployment: {report.get('deployment','unrecorded')}.","",
      f"{summary['cases']} cases; {summary['confirmed_final_replies']} confirmed final replies; {summary['objective_passes']}/{summary['objectively_graded']} objective checks passed by case.","",
      f"First message p50/p95: {sec(summary['first_message_p50_ms'])} / {sec(summary['first_message_p95_ms'])}. Completion p50/p95: {sec(summary['completion_p50_ms'])} / {sec(summary['completion_p95_ms'])}.","",
      "| Case | First message | Queue to model | Complete | Longest silence | Updates | Tool errors | Objective result |", "|---|---:|---:|---:|---:|---:|---:|---|"]
    for r in report["results"]:
        passed="ungraded" if r["objective_pass"] is None else "pass" if r["objective_pass"] else "fail"
        lines.append(f"| {r['case']} | {sec(r['first_message_ms'])} | {sec(r['queue_to_first_model_ms'])} | {sec(r['completion_ms'])} | {sec(r['max_silence_ms'])} | {r['intermediate_messages']} | {len(r['tool_errors'])} | {passed} |")
    lines += ["", "Limits: small sequential sample in an existing conversation; cold starts and prior memory affect timings. Host-only measurements do not prove Telegram client visibility. Percentiles include only observed replies; missing replies are counted separately. Link presence does not establish factual accuracy. Progress messages are assessed for usefulness during review; no fixed acknowledgement cadence is required.",""]
    for r in report["results"]:
        if r["ux_flags"] or r["tool_errors"]:
            lines += [f"## {r['case']}", "", ", ".join(r["ux_flags"]) or "Tool errors", "", json.dumps(r["tool_errors"],ensure_ascii=False), ""]
    return "\n".join(lines)
