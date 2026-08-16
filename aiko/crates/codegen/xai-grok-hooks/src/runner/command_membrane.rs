use crate::data_membrane::HookDataPolicy;
use std::path::{Path, PathBuf};

/// Canonicalize a direct executable and refuse `..`/symlink escapes from the
/// workspace. An out-of-workspace command needs an explicit capability.
pub fn confined_command(
    path: &Path,
    workspace: &Path,
    policy: &HookDataPolicy,
) -> Result<PathBuf, String> {
    let resolved = path
        .canonicalize()
        .map_err(|e| format!("command path is not usable: {e}"))?;
    let root = workspace
        .canonicalize()
        .map_err(|e| format!("workspace is not usable: {e}"))?;
    if !resolved.starts_with(&root) && !policy.allows("command:path_outside_workspace") {
        return Err("command path escapes workspace confinement".into());
    }
    Ok(resolved)
}

pub fn shell_allowed(policy: &HookDataPolicy) -> bool {
    policy.allows("command:shell")
}
