//! binary_ast.zig — pointer-indexed command-surface lexicon for four system binaries:
//! git, git-lfs, docker, and gh (GitHub CLI). Each binary's subcommands are mapped to
//! a comptime-known tree of CommandNode structs; the lookup() router resolves a binary×verb
//! tuple to a description string. The lookupAstJson() surface exports the full tree as a
//! JSON pointer-index so the substrate can route action plans through real binaries without
//! shell help-dumps.
//!
//! Discipline: these are pointers (a binary name → a subcommand → a one-line description),
//! not inline payload dumps. The binary IS the truth; this module points to it. When a
//! binary version changes and a subcommand moves/disappears, this module silently dead-ends
//! (no fabricated output, no crash) — lookup returns null.

const std = @import("std");

pub const CommandNode = struct {
    name: []const u8,
    desc: []const u8,
    subs: []const CommandNode,
};

pub const BinaryAst = struct {
    name: []const u8,
    version: []const u8, // captured at build-time; informational
    root: CommandNode,
};

// ── git AST ────────────────────────────────────────────────────────────────────────────────
const gitSubs = [_]CommandNode{
    .{ .name = "add", .desc = "Add file contents to the index", .subs = &.{} },
    .{ .name = "branch", .desc = "List, create, or delete branches", .subs = &.{} },
    .{ .name = "checkout", .desc = "Switch branches or restore working tree files", .subs = &.{} },
    .{ .name = "cherry-pick", .desc = "Apply the changes introduced by some existing commits", .subs = &.{} },
    .{ .name = "clone", .desc = "Clone a repository into a new directory", .subs = &.{} },
    .{ .name = "commit", .desc = "Record changes to the repository", .subs = &.{} },
    .{ .name = "diff", .desc = "Show changes between commits, commit and working tree", .subs = &.{} },
    .{ .name = "fetch", .desc = "Download objects and refs from another repository", .subs = &.{} },
    .{ .name = "init", .desc = "Create an empty Git repository or reinitialize an existing one", .subs = &.{} },
    .{ .name = "log", .desc = "Show commit logs", .subs = &.{} },
    .{ .name = "merge", .desc = "Join two or more development histories together", .subs = &.{} },
    .{ .name = "mv", .desc = "Move or rename a file, a directory, or a symlink", .subs = &.{} },
    .{ .name = "pull", .desc = "Fetch from and integrate with another repository or a local branch", .subs = &.{} },
    .{ .name = "push", .desc = "Update remote refs along with associated objects", .subs = &.{} },
    .{ .name = "rebase", .desc = "Reapply commits on top of another base tip", .subs = &.{} },
    .{ .name = "reflog", .desc = "Manage reflog information", .subs = &.{} },
    .{ .name = "reset", .desc = "Reset current HEAD to the specified state", .subs = &.{} },
    .{ .name = "restore", .desc = "Restore working tree files", .subs = &.{} },
    .{ .name = "revert", .desc = "Revert some existing commits", .subs = &.{} },
    .{ .name = "rm", .desc = "Remove files from the working tree and from the index", .subs = &.{} },
    .{ .name = "show", .desc = "Show various types of objects", .subs = &.{} },
    .{ .name = "stash", .desc = "Stash the changes in a dirty working directory away", .subs = &.{} },
    .{ .name = "status", .desc = "Show the working tree status", .subs = &.{} },
    .{ .name = "submodule", .desc = "Initialize, update or inspect submodules", .subs = &.{} },
    .{ .name = "switch", .desc = "Switch branches", .subs = &.{} },
    .{ .name = "tag", .desc = "Create, list, delete or verify a tag object signed with GPG", .subs = &.{} },
    .{ .name = "worktree", .desc = "Manage multiple working trees", .subs = &.{} },
    .{ .name = "bisect", .desc = "Use binary search to find the commit that introduced a bug", .subs = &.{} },
    .{ .name = "blame", .desc = "Show what revision and author last modified each line of a file", .subs = &.{} },
    .{ .name = "clean", .desc = "Remove untracked files from the working tree", .subs = &.{} },
    .{ .name = "gc", .desc = "Cleanup unnecessary files and optimize the local repository", .subs = &.{} },
    .{ .name = "remote", .desc = "Manage set of tracked repositories", .subs = &.{} },
    .{ .name = "config", .desc = "Get and set repository or global options", .subs = &.{} },
    .{ .name = "annotate", .desc = "Annotate file lines with commit information", .subs = &.{} },
    .{ .name = "archive", .desc = "Create an archive of files from a named tree", .subs = &.{} },
    .{ .name = "describe", .desc = "Give an object a human readable name based on an available ref", .subs = &.{} },
    .{ .name = "sparse-checkout", .desc = "Reduce your working tree to a subset of tracked files", .subs = &.{} },
    .{ .name = "filter-branch", .desc = "Rewrite branches", .subs = &.{} },
    .{ .name = "mergetool", .desc = "Run merge conflict resolution tools to resolve merge conflicts", .subs = &.{} },
    .{ .name = "notes", .desc = "Add or inspect object notes", .subs = &.{} },
    .{ .name = "range-diff", .desc = "Compare two commit ranges (e.g. two versions of a branch)", .subs = &.{} },
    .{ .name = "scalar", .desc = "A tool for managing large Git repositories", .subs = &.{} },
    .{ .name = "shortlog", .desc = "Summarize 'git log' output", .subs = &.{} },
    .{ .name = "bugreport", .desc = "Collect information for user to file a bug report", .subs = &.{} },
    .{ .name = "bundle", .desc = "Move objects and refs by archive", .subs = &.{} },
    .{ .name = "format-patch", .desc = "Prepare patches for e-mail submission", .subs = &.{} },
    .{ .name = "maintenance", .desc = "Run tasks to optimize Git repository data", .subs = &.{} },
    .{ .name = "repack", .desc = "Pack unpacked objects in a repository", .subs = &.{} },
    .{ .name = "replace", .desc = "Create, list, delete refs to replace objects", .subs = &.{} },
    .{ .name = "fast-export", .desc = "Git data exporter", .subs = &.{} },
    .{ .name = "fast-import", .desc = "Backend for fast Git data importers", .subs = &.{} },
};

// ── git-lfs AST ────────────────────────────────────────────────────────────────────────────
const gitLfsSubs = [_]CommandNode{
    .{ .name = "install", .desc = "Install Git LFS configuration (once per user)", .subs = &.{} },
    .{ .name = "track", .desc = "View or add Git LFS paths to Git attributes", .subs = &.{} },
    .{ .name = "untrack", .desc = "Remove Git LFS paths from Git attributes", .subs = &.{} },
    .{ .name = "ls-files", .desc = "Show information about Git LFS files", .subs = &.{} },
    .{ .name = "push", .desc = "Push queued large files to the Git LFS endpoint", .subs = &.{} },
    .{ .name = "fetch", .desc = "Download Git LFS files from the configured remote", .subs = &.{} },
    .{ .name = "pull", .desc = "Download Git LFS files at current ref and checkout", .subs = &.{} },
    .{ .name = "checkout", .desc = "Populate working copy with real file contents", .subs = &.{} },
    .{ .name = "locks", .desc = "List currently locked files", .subs = &.{} },
    .{ .name = "lock", .desc = "Set a file as locked on the Git LFS server", .subs = &.{} },
    .{ .name = "unlock", .desc = "Remove the lock on a file", .subs = &.{} },
    .{ .name = "migrate", .desc = "Convert a Git repo's history between LFS and plain Git", .subs = &.{} },
    .{ .name = "prune", .desc = "Delete old Git LFS files from local storage", .subs = &.{} },
    .{ .name = "smudge", .desc = "Download the Git LFS object contents for a pointer file (filter)", .subs = &.{} },
    .{ .name = "clean", .desc = "Create a new pointer file from the current content (filter)", .subs = &.{} },
    .{ .name = "status", .desc = "Show the status of Git LFS files", .subs = &.{} },
    .{ .name = "uninstall", .desc = "Remove Git LFS configuration", .subs = &.{} },
    .{ .name = "env", .desc = "Display the Git LFS environment", .subs = &.{} },
    .{ .name = "update", .desc = "Update Git LFS to the latest version", .subs = &.{} },
    .{ .name = "post-commit", .desc = "Git LFS post-commit hook", .subs = &.{} },
    .{ .name = "post-merge", .desc = "Git LFS post-merge hook", .subs = &.{} },
    .{ .name = "pre-push", .desc = "Git LFS pre-push hook", .subs = &.{} },
    .{ .name = "ext", .desc = "View or add Git LFS extensions", .subs = &.{} },
    .{ .name = "pointer", .desc = "Build and compare pointers between blob and LFS", .subs = &.{} },
    .{ .name = "standalone-file", .desc = "Build standalone transfer agent configuration", .subs = &.{} },
    .{ .name = "dedup", .desc = "De-duplicate local LFS object storage", .subs = &.{} },
    .{ .name = "logs", .desc = "Show errors from the git-lfs command", .subs = &.{} },
    .{ .name = "completion", .desc = "Generate shell completion scripts", .subs = &.{} },
    .{ .name = "version", .desc = "Show the git-lfs version", .subs = &.{} },
    .{ .name = "filter-process", .desc = "Process the Git filter operation (internal hook)", .subs = &.{} },
};

// ── docker AST ─────────────────────────────────────────────────────────────────────────────
const dockerSubs = [_]CommandNode{
    .{ .name = "build", .desc = "Build an image using instructions from Containerfiles", .subs = &.{} },
    .{ .name = "run", .desc = "Run a command in a new container", .subs = &.{} },
    .{ .name = "exec", .desc = "Run a process in a running container", .subs = &.{} },
    .{ .name = "ps", .desc = "List containers (default: running)", .subs = &.{} },
    .{ .name = "pull", .desc = "Pull an image or a repository from a registry", .subs = &.{} },
    .{ .name = "push", .desc = "Push an image or a repository to a registry", .subs = &.{} },
    .{ .name = "images", .desc = "List images in local storage", .subs = &.{} },
    .{ .name = "tag", .desc = "Create a tag TARGET_IMAGE that refers to SOURCE_IMAGE", .subs = &.{} },
    .{ .name = "rmi", .desc = "Remove one or more images", .subs = &.{} },
    .{ .name = "start", .desc = "Start one or more stopped containers", .subs = &.{} },
    .{ .name = "stop", .desc = "Stop one or more running containers", .subs = &.{} },
    .{ .name = "restart", .desc = "Restart one or more containers", .subs = &.{} },
    .{ .name = "kill", .desc = "Kill one or more running containers with a specific signal", .subs = &.{} },
    .{ .name = "rm", .desc = "Remove one or more containers", .subs = &.{} },
    .{ .name = "logs", .desc = "Fetch the logs of one or more containers", .subs = &.{} },
    .{ .name = "inspect", .desc = "Display the configuration of object denoted by ID", .subs = &.{} },
    .{ .name = "cp", .desc = "Copy files/folders between a container and the local filesystem", .subs = &.{} },
    .{ .name = "commit", .desc = "Create new image based on the changed container", .subs = &.{} },
    .{ .name = "export", .desc = "Export container's filesystem contents as a tar archive", .subs = &.{} },
    .{ .name = "import", .desc = "Import a tarball to create a filesystem image", .subs = &.{} },
    .{ .name = "load", .desc = "Load image(s) from a tar archive", .subs = &.{} },
    .{ .name = "save", .desc = "Save image(s) to an archive", .subs = &.{} },
    .{ .name = "login", .desc = "Log in to a container registry", .subs = &.{} },
    .{ .name = "logout", .desc = "Log out of a container registry", .subs = &.{} },
    .{ .name = "attach", .desc = "Attach to a running container", .subs = &.{} },
    .{ .name = "create", .desc = "Create but do not start a container", .subs = &.{} },
    .{ .name = "diff", .desc = "Display the changes to the object's file system", .subs = &.{} },
    .{ .name = "events", .desc = "Show system events", .subs = &.{} },
    .{ .name = "history", .desc = "Show history of a specified image", .subs = &.{} },
    .{ .name = "pause", .desc = "Pause all processes in one or more containers", .subs = &.{} },
    .{ .name = "unpause", .desc = "Unpause all processes in one or more containers", .subs = &.{} },
    .{ .name = "port", .desc = "List port mappings or a specific mapping for a container", .subs = &.{} },
    .{ .name = "rename", .desc = "Rename a container", .subs = &.{} },
    .{ .name = "stats", .desc = "Display a live stream of container resource usage statistics", .subs = &.{} },
    .{ .name = "top", .desc = "Display the running processes of a container", .subs = &.{} },
    .{ .name = "wait", .desc = "Block until one or more containers stop, then print their exit codes", .subs = &.{} },
    .{ .name = "compose", .desc = "Run compose workloads via docker-compose or podman-compose", .subs = &.{} },
    .{ .name = "network", .desc = "Manage networks", .subs = &.{} },
    .{ .name = "volume", .desc = "Manage volumes", .subs = &.{} },
    .{ .name = "container", .desc = "Manage containers (sub-resource surface)", .subs = &.{} },
    .{ .name = "image", .desc = "Manage images (sub-resource surface)", .subs = &.{} },
    .{ .name = "pod", .desc = "Manage pods", .subs = &.{} },
    .{ .name = "machine", .desc = "Manage a virtual machine", .subs = &.{} },
    .{ .name = "healthcheck", .desc = "Manage health checks on containers", .subs = &.{} },
    .{ .name = "kube", .desc = "Play containers, pods or volumes from a structured file", .subs = &.{} },
    .{ .name = "artifact", .desc = "Manage OCI artifacts", .subs = &.{} },
    .{ .name = "manifest", .desc = "Manipulate manifest lists and image indexes", .subs = &.{} },
    .{ .name = "generate", .desc = "Generate structured data based on containers, pods or volumes", .subs = &.{} },
    .{ .name = "init", .desc = "Initialize one or more containers", .subs = &.{} },
    .{ .name = "info", .desc = "Display system information", .subs = &.{} },
    .{ .name = "farm", .desc = "Farm out builds to remote machines", .subs = &.{} },
};

// ── gh (GitHub CLI) AST ────────────────────────────────────────────────────────────────────

// gh issue subcommands
const ghIssueSubs = [_]CommandNode{
    .{ .name = "create", .desc = "Create a new issue", .subs = &.{} },
    .{ .name = "list", .desc = "List issues in a repository", .subs = &.{} },
    .{ .name = "status", .desc = "Show status of relevant issues", .subs = &.{} },
    .{ .name = "close", .desc = "Close issue", .subs = &.{} },
    .{ .name = "comment", .desc = "Add a comment to an issue", .subs = &.{} },
    .{ .name = "delete", .desc = "Delete issue", .subs = &.{} },
    .{ .name = "edit", .desc = "Edit issues", .subs = &.{} },
    .{ .name = "lock", .desc = "Lock issue conversation", .subs = &.{} },
    .{ .name = "pin", .desc = "Pin an issue", .subs = &.{} },
    .{ .name = "reopen", .desc = "Reopen issue", .subs = &.{} },
    .{ .name = "transfer", .desc = "Transfer issue to another repository", .subs = &.{} },
    .{ .name = "develop", .desc = "Manage linked branches for an issue", .subs = &.{} },
    .{ .name = "view", .desc = "View an issue", .subs = &.{} },
};

// gh pr subcommands
const ghPrSubs = [_]CommandNode{
    .{ .name = "create", .desc = "Create a pull request", .subs = &.{} },
    .{ .name = "list", .desc = "List pull requests in a repository", .subs = &.{} },
    .{ .name = "status", .desc = "Show status of relevant pull requests", .subs = &.{} },
    .{ .name = "checkout", .desc = "Check out a pull request in git", .subs = &.{} },
    .{ .name = "checks", .desc = "Show CI status for a single pull request", .subs = &.{} },
    .{ .name = "close", .desc = "Close a pull request", .subs = &.{} },
    .{ .name = "comment", .desc = "Add a comment to a pull request", .subs = &.{} },
    .{ .name = "diff", .desc = "View changes in a pull request", .subs = &.{} },
    .{ .name = "edit", .desc = "Edit a pull request", .subs = &.{} },
    .{ .name = "lock", .desc = "Lock pull request conversation", .subs = &.{} },
    .{ .name = "merge", .desc = "Merge a pull request", .subs = &.{} },
    .{ .name = "ready", .desc = "Mark a pull request as ready for review", .subs = &.{} },
    .{ .name = "review", .desc = "Add a review to a pull request", .subs = &.{} },
    .{ .name = "reopen", .desc = "Reopen a pull request", .subs = &.{} },
    .{ .name = "view", .desc = "View a pull request", .subs = &.{} },
};

// gh repo subcommands
const ghRepoSubs = [_]CommandNode{
    .{ .name = "create", .desc = "Create a new repository", .subs = &.{} },
    .{ .name = "list", .desc = "List repositories owned by user or organization", .subs = &.{} },
    .{ .name = "clone", .desc = "Clone a repository locally", .subs = &.{} },
    .{ .name = "fork", .desc = "Create a fork of a repository", .subs = &.{} },
    .{ .name = "view", .desc = "View a repository", .subs = &.{} },
    .{ .name = "archive", .desc = "Archive a repository", .subs = &.{} },
    .{ .name = "delete", .desc = "Delete a repository", .subs = &.{} },
    .{ .name = "edit", .desc = "Edit repository settings", .subs = &.{} },
    .{ .name = "rename", .desc = "Rename a repository", .subs = &.{} },
    .{ .name = "deploy-key", .desc = "Manage deploy keys in a repository", .subs = &.{} },
    .{ .name = "autolink", .desc = "Manage autolink references", .subs = &.{} },
};

// gh release subcommands
const ghReleaseSubs = [_]CommandNode{
    .{ .name = "create", .desc = "Create a new release", .subs = &.{} },
    .{ .name = "list", .desc = "List releases in a repository", .subs = &.{} },
    .{ .name = "view", .desc = "View a release", .subs = &.{} },
    .{ .name = "delete", .desc = "Delete a release", .subs = &.{} },
    .{ .name = "download", .desc = "Download release assets", .subs = &.{} },
    .{ .name = "edit", .desc = "Edit a release", .subs = &.{} },
    .{ .name = "upload", .desc = "Upload assets to a release", .subs = &.{} },
};

// gh run (Actions) subcommands
const ghRunSubs = [_]CommandNode{
    .{ .name = "list", .desc = "List recent workflow runs", .subs = &.{} },
    .{ .name = "view", .desc = "View a summary of a workflow run", .subs = &.{} },
    .{ .name = "watch", .desc = "Watch a run until it completes, showing progress", .subs = &.{} },
    .{ .name = "rerun", .desc = "Rerun a run", .subs = &.{} },
    .{ .name = "cancel", .desc = "Cancel a workflow run", .subs = &.{} },
    .{ .name = "delete", .desc = "Delete a workflow run", .subs = &.{} },
    .{ .name = "download", .desc = "Download artifacts generated by a workflow run", .subs = &.{} },
};

// gh workflow (Actions) subcommands
const ghWorkflowSubs = [_]CommandNode{
    .{ .name = "list", .desc = "List workflows", .subs = &.{} },
    .{ .name = "view", .desc = "View the summary of a workflow", .subs = &.{} },
    .{ .name = "enable", .desc = "Enable a workflow", .subs = &.{} },
    .{ .name = "disable", .desc = "Disable a workflow", .subs = &.{} },
    .{ .name = "run", .desc = "Run a workflow by creating a workflow dispatch event", .subs = &.{} },
};

const ghSubs = [_]CommandNode{
    .{ .name = "auth", .desc = "Authenticate gh and git with GitHub", .subs = &.{} },
    .{ .name = "browse", .desc = "Open repositories, issues, pull requests in browser", .subs = &.{} },
    .{ .name = "codespace", .desc = "Connect to and manage codespaces", .subs = &.{} },
    .{ .name = "gist", .desc = "Manage gists", .subs = &.{} },
    .{ .name = "issue", .desc = "Manage issues", .subs = &ghIssueSubs },
    .{ .name = "org", .desc = "Manage organizations", .subs = &.{} },
    .{ .name = "project", .desc = "Work with GitHub Projects", .subs = &.{} },
    .{ .name = "release", .desc = "Manage releases", .subs = &ghReleaseSubs },
    .{ .name = "repo", .desc = "Manage repositories", .subs = &ghRepoSubs },
    .{ .name = "pr", .desc = "Manage pull requests", .subs = &ghPrSubs },
    .{ .name = "run", .desc = "View details about workflow runs (GitHub Actions)", .subs = &ghRunSubs },
    .{ .name = "workflow", .desc = "View details about GitHub Actions workflows", .subs = &ghWorkflowSubs },
    .{ .name = "cache", .desc = "Manage GitHub Actions caches", .subs = &.{} },
    .{ .name = "alias", .desc = "Create command shortcuts", .subs = &.{} },
    .{ .name = "api", .desc = "Make an authenticated GitHub API request", .subs = &.{} },
    .{ .name = "attestation", .desc = "Work with artifact attestations", .subs = &.{} },
    .{ .name = "completion", .desc = "Generate shell completion scripts", .subs = &.{} },
    .{ .name = "config", .desc = "Manage configuration for gh", .subs = &.{} },
    .{ .name = "copilot", .desc = "Run the GitHub Copilot CLI", .subs = &.{} },
    .{ .name = "extension", .desc = "Manage gh extensions", .subs = &.{} },
    .{ .name = "label", .desc = "Manage labels", .subs = &.{} },
    .{ .name = "ruleset", .desc = "View info about repo rulesets", .subs = &.{} },
    .{ .name = "search", .desc = "Search for repositories, issues, and pull requests", .subs = &.{} },
    .{ .name = "secret", .desc = "Manage GitHub Actions secrets", .subs = &.{} },
    .{ .name = "variable", .desc = "Manage GitHub Actions variables", .subs = &.{} },
    .{ .name = "agent-task", .desc = "Work with agent tasks (preview)", .subs = &.{} },
};

// ── Master registry ────────────────────────────────────────────────────────────────────────
pub const registries = [_]BinaryAst{
    .{ .name = "git", .version = "2.50.1", .root = .{ .name = "git", .desc = "Distributed version control system (Apple Git)", .subs = &gitSubs } },
    .{ .name = "git-lfs", .version = "3.7.1", .root = .{ .name = "git-lfs", .desc = "Git extension for versioning large files via pointer files + server-side storage", .subs = &gitLfsSubs } },
    .{ .name = "docker", .version = "5.8.2", .root = .{ .name = "docker", .desc = "Manage pods, containers, and images (docker CLI)", .subs = &dockerSubs } },
    .{ .name = "gh", .version = "2.88.1", .root = .{ .name = "gh", .desc = "GitHub CLI — issues, PRs, releases, repos, Actions, API", .subs = &ghSubs } },
};

// ── Lookup router ──────────────────────────────────────────────────────────────────────────

/// Resolve a binary×verb tuple to a one-line description. Returns null when the binary
/// or verb is absent from the lexicon (silently dead-ends — no fabricated output).
pub fn lookup(binary: []const u8, verb: []const u8) ?[]const u8 {
    for (&registries) |reg| {
        if (!std.mem.eql(u8, binary, reg.name)) continue;
        for (reg.root.subs) |sub| {
            if (std.mem.eql(u8, verb, sub.name)) return sub.desc;
        }
        break;
    }
    return null;
}

/// Resolve a binary×verb×subverb tuple (e.g., "gh" × "pr" × "merge"). Returns null on miss.
pub fn lookupSub(binary: []const u8, verb: []const u8, subverb: []const u8) ?[]const u8 {
    for (&registries) |reg| {
        if (!std.mem.eql(u8, binary, reg.name)) continue;
        for (reg.root.subs) |sub| {
            if (!std.mem.eql(u8, verb, sub.name)) continue;
            for (sub.subs) |ss| {
                if (std.mem.eql(u8, subverb, ss.name)) return ss.desc;
            }
            break;
        }
        break;
    }
    return null;
}

/// Return a flat JSON array of every `binary×verb → desc` entry in the lexicon.
/// Caller frees.
pub fn lookupAstJson(allocator: std.mem.Allocator) ![]u8 {
    var buf: std.ArrayList(u8) = .empty;
    try buf.appendSlice(allocator, "[");
    var first: bool = true;
    for (&registries) |reg| {
        for (reg.root.subs) |sub| {
            if (!first) try buf.appendSlice(allocator, ",");
            first = false;
            var entry_buf: [256]u8 = undefined;
            const entry = try std.fmt.bufPrint(&entry_buf, "{{\"binary\":\"{s}\",\"verb\":\"{s}\",\"desc\":\"{s}\"}}", .{ reg.name, sub.name, sub.desc });
            try buf.appendSlice(allocator, entry);
        }
    }
    try buf.appendSlice(allocator, "]");
    return buf.toOwnedSlice(allocator);
}

// ── Witness tests ──────────────────────────────────────────────────────────────────────────

test "binary_ast lookup — git add returns its description" {
    const d = lookup("git", "add");
    try std.testing.expect(d != null);
    try std.testing.expect(std.mem.indexOf(u8, d.?, "Add file contents") != null);
}

test "binary_ast lookup — docker build returns its description" {
    const d = lookup("docker", "build");
    try std.testing.expect(d != null);
    try std.testing.expect(std.mem.indexOf(u8, d.?, "Build an image") != null);
}

test "binary_ast lookup — absent binary → null (no fabricated output)" {
    try std.testing.expectEqual(@as(?[]const u8, null), lookup("nonexistent", "run"));
}

test "binary_ast lookup — absent verb → null (silent miss)" {
    try std.testing.expectEqual(@as(?[]const u8, null), lookup("git", "nonexistent_verb"));
}

test "binary_ast lookupSub — gh pr merge returns description" {
    const d = lookupSub("gh", "pr", "merge");
    try std.testing.expect(d != null);
    try std.testing.expect(std.mem.indexOf(u8, d.?, "Merge a pull request") != null);
}

test "binary_ast lookupSub — gh run rerun returns description" {
    const d = lookupSub("gh", "run", "rerun");
    try std.testing.expect(d != null);
    try std.testing.expect(std.mem.indexOf(u8, d.?, "Rerun a run") != null);
}

test "binary_ast lookupSub — gh issue transfer returns description" {
    const d = lookupSub("gh", "issue", "transfer");
    try std.testing.expect(d != null);
    try std.testing.expect(std.mem.indexOf(u8, d.?, "Transfer issue") != null);
}

test "binary_ast lookupSub — absent subverb → null (silent miss)" {
    try std.testing.expectEqual(@as(?[]const u8, null), lookupSub("gh", "pr", "frobnicate"));
}

test "binary_ast lookupSub — absent binary → null" {
    try std.testing.expectEqual(@as(?[]const u8, null), lookupSub("frobbinator", "pr", "merge"));
}

test "binary_ast — all four registries present with correct version strings" {
    var found: [4]bool = [_]bool{false} ** 4;
    for (&registries) |reg| {
        if (std.mem.eql(u8, reg.name, "git")) {
            found[0] = true;
            try std.testing.expect(std.mem.eql(u8, reg.version, "2.50.1"));
        }
        if (std.mem.eql(u8, reg.name, "git-lfs")) {
            found[1] = true;
            try std.testing.expect(std.mem.eql(u8, reg.version, "3.7.1"));
        }
        if (std.mem.eql(u8, reg.name, "docker")) {
            found[2] = true;
            try std.testing.expect(std.mem.eql(u8, reg.version, "5.8.2"));
        }
        if (std.mem.eql(u8, reg.name, "gh")) {
            found[3] = true;
            try std.testing.expect(std.mem.eql(u8, reg.version, "2.88.1"));
        }
    }
    for (found) |f| try std.testing.expect(f);
}

test "binary_ast lookupAstJson — valid JSON array shape" {
    const a = std.testing.allocator;
    const j = try lookupAstJson(a);
    // zig 0.16 allocPrint in ArrayList context returns a fresh allocation; free it here
    defer a.free(j);
    try std.testing.expect(j.len > 50);
    try std.testing.expect(j[0] == '[' and j[j.len - 1] == ']');
    try std.testing.expect(std.mem.indexOf(u8, j, "\"binary\":\"git\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, j, "\"binary\":\"gh\"") != null);
}
