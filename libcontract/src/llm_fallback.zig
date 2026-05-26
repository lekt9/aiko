//! llm_fallback.zig — local LLM compile fallback for the wallet-empty case.
//!
//! When `aiko "<goal>" --remote` returns PaymentRequired (wallet has no
//! balance for the x402 call to Unbrowse), the substrate falls back to a
//! locally-spawned llama.cpp + Qwen3.5-0.8B-Instruct (GGUF, Q4_K_M ~530MB).
//! Both the inference engine and the model are downloaded on first use
//! into `~/.aiko/models/` and cached forever. The user never sees this —
//! it fires silently when the wallet 402s.
//!
//! Why not ollama: ollama is a daemon with a registry mediator; the
//! substrate is short-lived neurons. llama.cpp ships as a single binary
//! the substrate spawns directly with GBNF grammar enforcing JSON.
//!
//! Public surface: `compileLocallyJson(allocator, env, plan) !?[]u8` —
//! returns the AikoCompiledContract JSON string (caller frees) or null
//! when the local model can't run (e.g. unsupported platform).

const std = @import("std");

extern fn popen(cmd: [*:0]const u8, mode: [*:0]const u8) ?*anyopaque;
extern fn pclose(stream: *anyopaque) c_int;
extern fn fread(ptr: [*]u8, size: usize, nmemb: usize, stream: *anyopaque) usize;
extern fn access(path: [*:0]const u8, mode: c_int) c_int;
extern fn system(cmd: [*:0]const u8) c_int;

const F_OK: c_int = 0;

pub const Error = error{
    HomeMissing,
    DownloadFailed,
    ExtractFailed,
    SpawnFailed,
    NoJsonInOutput,
    UnsupportedPlatform,
    OutOfMemory,
};

/// Pinned llama.cpp release tag. Bump when re-pinning to a newer build.
/// All four supported platforms ship under the same tag.
const LLAMA_CPP_TAG = "b9329";

/// Model: the most-downloaded GGUF of Qwen3.5-0.8B-Instruct.
/// `unsloth` ships within hours of each Qwen release and Q4_K_M is the
/// sweet-spot quantization for ~600MB on disk + ~1.2GB resident.
const MODEL_REPO = "unsloth/Qwen3.5-0.8B-GGUF";
const MODEL_FILE = "Qwen3.5-0.8B-Q4_K_M.gguf";

/// GBNF grammar enforcing a JSON object shape. Llama.cpp's grammar engine
/// will refuse to emit any token that violates this — guarantees we get
/// parseable JSON back. The grammar is intentionally lenient on internal
/// structure (any nested JSON value); the substrate's normalizer in
/// `normalizeAikoContractTree` handles missing fields.
const GRAMMAR_GBNF =
    \\root   ::= object
    \\object ::= "{" ws ( string ":" ws value ("," ws string ":" ws value)* )? "}" ws
    \\value  ::= object | array | string | number | "true" | "false" | "null"
    \\array  ::= "[" ws ( value ("," ws value)* )? "]" ws
    \\string ::= "\"" ( [^"\\] | "\\" ["\\/bfnrt] | "\\u" [0-9a-fA-F]{4} )* "\"" ws
    \\number ::= "-"? ("0" | [1-9][0-9]*) ("." [0-9]+)? ([eE][-+]?[0-9]+)? ws
    \\ws     ::= [ \t\n]*
;

const SYSTEM_PROMPT =
    \\Compile one aiko prompt into a minimal non-contradicting recursive aiko contract tree.
    \\Return ONLY a JSON object of shape:
    \\{"prompt":string,"posthook_pointer":"optional http(s) or contract: pointer","wallet_identity":"optional wallet pointer","replicated_from_contract_id":"optional out-of-lineage contract id","network_tunnel_contract_id":"optional tunnel adapter contract pointer","network_tunnel_kind":"optional tunnel class","evaluators":[{"prompt":string,"metric":{"source":"api|ledger|external","pointer":string,"assertion":string}}],"children":[same shape]}
    \\Every node and evaluator is an aiko declaration prompt. A goal is true only when its evaluator metrics resolve true. No prose outside JSON.
;

/// Public entry: produce the local-LLM-compiled AikoCompiledContract JSON
/// for `plan`, or null if local compile is unavailable on this platform.
/// Caller owns the returned slice.
pub fn compileLocallyJson(
    allocator: std.mem.Allocator,
    env: std.process.Environ,
    plan: []const u8,
) Error!?[]u8 {
    const home = env.getPosix("HOME") orelse return Error.HomeMissing;

    // Resolve cache paths.
    const models_dir = try std.fmt.allocPrint(allocator, "{s}/.aiko/models", .{home});
    defer allocator.free(models_dir);
    // The release tarball extracts to <models_dir>/llama-cli/llama-<TAG>/...
    // Keep the binary INSIDE its companion-dylib directory so @rpath resolves
    // (libllama.dylib, libggml.dylib, etc. all sit next to llama-cli).
    const llama_cli = try std.fmt.allocPrint(allocator, "{s}/llama-cli/llama-{s}/llama-cli", .{ models_dir, LLAMA_CPP_TAG });
    defer allocator.free(llama_cli);
    const model_path = try std.fmt.allocPrint(allocator, "{s}/{s}", .{ models_dir, MODEL_FILE });
    defer allocator.free(model_path);
    const grammar_path = try std.fmt.allocPrint(allocator, "{s}/contract.gbnf", .{models_dir});
    defer allocator.free(grammar_path);

    // Ensure the dir exists.
    try shell(allocator, "mkdir -p '{s}/llama-cli'", .{models_dir});

    // Ensure the grammar file is written (idempotent — overwrite each run
    // so a doctrine change here flows through without manual eviction).
    try writeFile(allocator, grammar_path, GRAMMAR_GBNF);

    // Ensure llama-cli is fetched + extracted. Tarball extracts into
    // `<models_dir>/llama-cli/llama-<TAG>/` with the binary + companion
    // dylibs all in that one directory — leave them there.
    if (!pathExists(llama_cli)) {
        const tarball_url = platformLlamaCppUrl() orelse return Error.UnsupportedPlatform;
        const tarball_path = try std.fmt.allocPrint(allocator, "{s}/llama-cli/release.tar.gz", .{models_dir});
        defer allocator.free(tarball_path);
        try shell(allocator, "curl -fsSL '{s}' -o '{s}'", .{ tarball_url, tarball_path });
        try shell(allocator, "tar -xzf '{s}' -C '{s}/llama-cli'", .{ tarball_path, models_dir });
        try shell(allocator, "chmod +x '{s}' 2>/dev/null || true", .{llama_cli});
        if (!pathExists(llama_cli)) return Error.ExtractFailed;
    }

    // Ensure model GGUF is fetched.
    if (!pathExists(model_path)) {
        const model_url = try std.fmt.allocPrint(
            allocator,
            "https://huggingface.co/{s}/resolve/main/{s}",
            .{ MODEL_REPO, MODEL_FILE },
        );
        defer allocator.free(model_url);
        try shell(allocator, "curl -fsSL '{s}' -o '{s}'", .{ model_url, model_path });
        if (!pathExists(model_path)) return Error.DownloadFailed;
    }

    // Spawn llama-cli with grammar + prompt. Write the combined prompt to
    // a temp file because the user goal may contain shell-meta chars and
    // we want llama-cli to receive it via -f rather than -p.
    const prompt_path = try std.fmt.allocPrint(allocator, "{s}/.last-prompt.txt", .{models_dir});
    defer allocator.free(prompt_path);
    const combined = try std.fmt.allocPrint(allocator, "{s}\n\nUser goal: {s}\n\nJSON:", .{ SYSTEM_PROMPT, plan });
    defer allocator.free(combined);
    try writeFile(allocator, prompt_path, combined);

    // -n 256:       compiled trees are small; 1024 was wasteful.
    // -t 4:         cap thread count so we don't pin every core.
    // --single-turn: exit after generating one response (otherwise llama-cli
    //               sits at an interactive `>` prompt forever).
    // 2>&1:         llama-cli writes the GENERATED text to stderr, not stdout
    //               (only the loading spinner goes to stdout). Merge them so
    //               popen captures the actual JSON output. The
    //               extractFirstJsonObject pass finds the JSON in the
    //               merged stream — banner/footer noise is tolerated.
    const cmd_slice = std.fmt.allocPrint(
        allocator,
        "'{s}' -m '{s}' --grammar-file '{s}' -f '{s}' -n 256 -t 4 --temp 0.1 --no-display-prompt --single-turn 2>&1",
        .{ llama_cli, model_path, grammar_path, prompt_path },
    ) catch return Error.OutOfMemory;
    defer allocator.free(cmd_slice);
    const cmd_z = allocator.dupeZ(u8, cmd_slice) catch return Error.OutOfMemory;
    defer allocator.free(cmd_z);

    const f = popen(cmd_z.ptr, "r") orelse return Error.SpawnFailed;
    defer _ = pclose(f);

    var out_buf: std.ArrayList(u8) = .empty;
    defer out_buf.deinit(allocator);
    var chunk: [4096]u8 = undefined;
    while (true) {
        const got = fread(&chunk, 1, chunk.len, f);
        if (got == 0) break;
        out_buf.appendSlice(allocator, chunk[0..got]) catch return Error.OutOfMemory;
    }

    // Extract the first balanced { … } from the model's output.
    const json_slice = extractFirstJsonObject(out_buf.items) orelse return Error.NoJsonInOutput;
    const owned = allocator.dupe(u8, json_slice) catch return Error.OutOfMemory;
    return owned;
}

// ──────────────────────────────────────────────────────────────────────────
// Platform detection

fn platformLlamaCppUrl() ?[]const u8 {
    const builtin = @import("builtin");
    // Naming follows ggml-org/llama.cpp release assets (tag b9329 conventions).
    return switch (builtin.target.os.tag) {
        .macos => switch (builtin.target.cpu.arch) {
            .aarch64 => "https://github.com/ggml-org/llama.cpp/releases/download/" ++ LLAMA_CPP_TAG ++ "/llama-" ++ LLAMA_CPP_TAG ++ "-bin-macos-arm64-kleidiai.tar.gz",
            .x86_64 => "https://github.com/ggml-org/llama.cpp/releases/download/" ++ LLAMA_CPP_TAG ++ "/llama-" ++ LLAMA_CPP_TAG ++ "-bin-macos-x64.tar.gz",
            else => null,
        },
        .linux => switch (builtin.target.cpu.arch) {
            .x86_64 => "https://github.com/ggml-org/llama.cpp/releases/download/" ++ LLAMA_CPP_TAG ++ "/llama-" ++ LLAMA_CPP_TAG ++ "-bin-ubuntu-x64.tar.gz",
            .aarch64 => "https://github.com/ggml-org/llama.cpp/releases/download/" ++ LLAMA_CPP_TAG ++ "/llama-" ++ LLAMA_CPP_TAG ++ "-bin-ubuntu-arm64.tar.gz",
            else => null,
        },
        else => null,
    };
}

// ──────────────────────────────────────────────────────────────────────────
// Small helpers

fn pathExists(path: []const u8) bool {
    var buf: [4096]u8 = undefined;
    if (path.len >= buf.len) return false;
    @memcpy(buf[0..path.len], path);
    buf[path.len] = 0;
    const path_z: [*:0]const u8 = @ptrCast(&buf);
    return access(path_z, F_OK) == 0;
}

fn shell(allocator: std.mem.Allocator, comptime fmt_str: []const u8, args: anytype) Error!void {
    const slice = std.fmt.allocPrint(allocator, fmt_str, args) catch return Error.OutOfMemory;
    defer allocator.free(slice);
    const cmd = allocator.dupeZ(u8, slice) catch return Error.OutOfMemory;
    defer allocator.free(cmd);
    const rc = system(cmd.ptr);
    if (rc != 0) return Error.DownloadFailed;
}

fn writeFile(allocator: std.mem.Allocator, path: []const u8, body: []const u8) Error!void {
    _ = allocator;
    var pbuf: [4096]u8 = undefined;
    if (path.len >= pbuf.len) return Error.OutOfMemory;
    @memcpy(pbuf[0..path.len], path);
    pbuf[path.len] = 0;
    const fd = std.c.open(@ptrCast(&pbuf), .{ .ACCMODE = .WRONLY, .CREAT = true, .TRUNC = true }, @as(std.c.mode_t, 0o644));
    if (fd < 0) return Error.DownloadFailed;
    defer _ = std.c.close(fd);
    var written: usize = 0;
    while (written < body.len) {
        const n = std.c.write(fd, body.ptr + written, body.len - written);
        if (n <= 0) return Error.DownloadFailed;
        written += @intCast(n);
    }
}

fn extractFirstJsonObject(haystack: []const u8) ?[]const u8 {
    var depth: i32 = 0;
    var start: ?usize = null;
    var in_string = false;
    var escape = false;
    for (haystack, 0..) |c, i| {
        if (in_string) {
            if (escape) {
                escape = false;
            } else if (c == '\\') {
                escape = true;
            } else if (c == '"') {
                in_string = false;
            }
            continue;
        }
        switch (c) {
            '"' => in_string = true,
            '{' => {
                if (depth == 0) start = i;
                depth += 1;
            },
            '}' => {
                depth -= 1;
                if (depth == 0 and start != null) return haystack[start.? .. i + 1];
            },
            else => {},
        }
    }
    return null;
}

// ──────────────────────────────────────────────────────────────────────────
// Tests

test "extractFirstJsonObject finds outer object" {
    const out = "garbage prelude {\"a\":1,\"b\":{\"c\":2}} trailing junk";
    const got = extractFirstJsonObject(out).?;
    try std.testing.expectEqualStrings("{\"a\":1,\"b\":{\"c\":2}}", got);
}

test "extractFirstJsonObject handles braces inside strings" {
    const out = "{\"a\":\"}{}}{\"} ";
    const got = extractFirstJsonObject(out).?;
    try std.testing.expectEqualStrings("{\"a\":\"}{}}{\"}", got);
}

test "extractFirstJsonObject returns null when no object" {
    try std.testing.expect(extractFirstJsonObject("no json here") == null);
}

test "platform URL returns a valid string on supported platforms" {
    const builtin = @import("builtin");
    const supported = (builtin.target.os.tag == .macos) or (builtin.target.os.tag == .linux);
    if (supported) {
        try std.testing.expect(platformLlamaCppUrl() != null);
    }
}
