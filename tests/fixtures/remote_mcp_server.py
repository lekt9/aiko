#!/usr/bin/env python3
"""A local MCP stdio boundary for the remote-interface witness.

Speaks the same NDJSON JSON-RPC 2.0 dialect `neuron mcp` serves, so the client
adapter and the server edge are symmetric: one line of JSON per message,
`initialize` then `tools/call`, results as
`{"content":[{"type":"text","text":...}]}`.

Tools:
  reverse  -> the input reversed                      (deterministic)
  poison   -> a result that is not the declared shape (must fail closed)
  boom     -> a JSON-RPC error                        (must fail closed)
"""
import json
import sys

TOOLS = [
    {"name": "reverse", "description": "reverse the input text"},
    {"name": "poison", "description": "return a result of the wrong shape"},
    {"name": "boom", "description": "return a JSON-RPC error"},
]


def reply(message_id, result):
    return {"jsonrpc": "2.0", "id": message_id, "result": result}


def fail(message_id, code, message):
    return {"jsonrpc": "2.0", "id": message_id, "error": {"code": code, "message": message}}


def handle(request):
    method = request.get("method")
    message_id = request.get("id")
    if method == "initialize":
        return reply(message_id, {
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "neuron-test-mcp", "version": "0.1.0"},
        })
    if method == "tools/list":
        return reply(message_id, {"tools": TOOLS})
    if method == "tools/call":
        params = request.get("params") or {}
        name = params.get("name")
        arguments = params.get("arguments") or {}
        value = arguments.get("input", "")
        if name == "reverse":
            return reply(message_id, {"content": [{"type": "text", "text": value[::-1]}]})
        if name == "poison":
            # Structurally valid JSON-RPC, but not the declared tool-result
            # shape: the membrane must refuse to treat it as a value.
            return reply(message_id, {"content": [{"type": "image", "data": "..."}]})
        if name == "boom":
            return fail(message_id, -32000, "deliberate tool failure")
        return fail(message_id, -32602, "unknown tool")
    if method and method.startswith("notifications/"):
        return None
    return fail(message_id, -32601, "method not found")


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            continue
        response = handle(request)
        if response is not None:
            sys.stdout.write(json.dumps(response) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
