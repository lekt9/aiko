//! Codegraff-ported tool primitives — faster, bounded, verified implementations
//! of read_file, edit_file, and write_file.
//!
//! Ported from [justrach/codegraff](https://github.com/justrach/codegraff):
//! - `src/read_file.zig` — streaming line-window reads, binary detection, preview truncation
//! - `src/edit_verify.zig` — post-write verification, concurrent write locks, companion-aware
//!
//! # Key differences from the existing Aiko Build tools
//!
//! | Feature                | Aiko Build              | Codegraff (this module)     |
//! |------------------------|-------------------------|------------------------------|
//! | Whole-file read        | Allocates full content  | Capped at 256KB + preview    |
//! | Line-range reads       | Allocates full file     | Streams through 16KB buffers |
//! | Binary detection       | Extension-based only    | Content scan (null bytes)    |
//! | Edit verification      | None                    | Re-reads file, byte-compares |
//! | Write locks            | None                    | Striped mutex per file hash  |
//! | Output cap             | Configurable            | Fixed 256KB + proportional   |
//! | Pre-write snapshot     | None                    | Rewind support via snapshots |

pub mod edit;
pub mod read;
pub mod write;

pub use edit::CodegraffEditTool;
pub use read::CodegraffReadTool;
pub use write::CodegraffWriteTool;
