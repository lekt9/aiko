use crate::types::requirements::{Expr, ToolRequirement};

use crate::types::tool::{ToolKind, ToolNamespace};

use super::interval::{interval_to_human, parse_interval};
use super::types::{ScheduledTask, SchedulerCommand, SchedulerHandle};
use std::sync::OnceLock;

// Canonical /loop wording lives in the light API crate so other consumers can
// link it without the tools implementation crate; re-exported to keep paths stable.
pub use xai_grok_tools_api::slash_commands::{
    SCHEDULER_CREATE_TOOL_NAME, loop_schedule_instruction, loop_usage_message,
};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
pub struct SchedulerCreateInput {
    /// Interval string: "5m", "2h", "1d", etc.
    #[schemars(description = "Interval between executions, e.g. \"5m\", \"2h\", \"1d\"")]
    pub interval: String,

    /// The prompt to run on each fire.
    #[schemars(description = "The prompt text to execute on each scheduled fire")]
    pub prompt: String,

    /// Whether the task recurs. Default true.
    #[serde(
        default = "default_true",
        deserialize_with = "crate::types::schema::deserialize_lenient_bool"
    )]
    #[schemars(
        description = "Whether the task repeats (true) or fires once (false). Default: true"
    )]
    pub recurring: bool,

    /// Whether the task persists across sessions. Default false (session-only).
    #[serde(
        default,
        deserialize_with = "crate::types::schema::deserialize_lenient_option_bool"
    )]
    #[schemars(description = "Whether the task persists across sessions. Default: false")]
    pub durable: Option<bool>,

    /// Whether to fire immediately on creation. Default false (wait for the
    /// first interval — a "scheduled" task should not run on creation unless
    /// explicitly asked to).
    #[serde(
        default,
        deserialize_with = "crate::types::schema::deserialize_lenient_bool"
    )]
    #[schemars(
        description = "Whether to fire immediately on creation (true) or wait for the first interval (false). Default: false"
    )]
    pub fire_immediately: bool,
}

fn default_true() -> bool {
    true
}

fn contract_library_candidates() -> Vec<std::path::PathBuf> {
    let mut paths = Vec::new();
    if let Some(path) = std::env::var_os("AIKO_CONTRACT_LIBRARY") {
        paths.push(path.into());
    }
    if let Ok(executable) = std::env::current_exe()
        && let Some(bin_dir) = executable.parent()
    {
        paths.push(bin_dir.join("../lib/libcontract.dylib"));
    }
    if let Some(home) = dirs::home_dir() {
        paths.push(home.join(".aiko/lib/libcontract.dylib"));
    }
    paths.push(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../../contract/libcontract/zig-out/lib/libcontract.dylib"),
    );
    // contract-core fallbacks
    if let Some(home) = dirs::home_dir() {
        paths.push(home.join("Unbrowse/contract-core/libcontract/zig-out/lib/libcontract.dylib"));
        paths.push(home.join("Unbrowse/contract-core/libcontract/zig-out/lib/libcontract.so"));
    }
    paths.push(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../../contract-core/libcontract/zig-out/lib/libcontract.dylib"),
    );
    paths.push(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../../contract-core/libcontract/zig-out/lib/libcontract.so"),
    );
    paths
}

use std::ffi::{CStr, CString, c_char};
type AbiVersionFn = unsafe extern "C" fn() -> u32;
type DeclareFn = unsafe extern "C" fn(*const c_char, *const c_char, u64, bool, i64) -> *mut c_char;
type CancelFn = unsafe extern "C" fn(*const c_char, *const c_char) -> i32;
type ListFn = unsafe extern "C" fn() -> *mut c_char;
type FreeFn = unsafe extern "C" fn(*mut c_char);

struct ScheduleAbi {
    _library: libloading::Library,
    declare: DeclareFn,
    cancel: CancelFn,
    list: ListFn,
    free: FreeFn,
}

fn schedule_abi() -> Option<&'static ScheduleAbi> {
    static ABI: OnceLock<Option<ScheduleAbi>> = OnceLock::new();
    ABI.get_or_init(|| {
        for path in contract_library_candidates() {
            let Ok(library) = (unsafe { libloading::Library::new(path) }) else {
                continue;
            };
            let Ok(version) = (unsafe { library.get::<AbiVersionFn>(b"contract_abi_version\0") })
            else {
                continue;
            };
            if unsafe { version() } < 3 {
                continue;
            }
            let Ok(declare) =
                (unsafe { library.get::<DeclareFn>(b"contract_declare_scheduled\0") })
            else {
                continue;
            };
            let Ok(cancel) = (unsafe { library.get::<CancelFn>(b"contract_cancel\0") }) else {
                continue;
            };
            let Ok(list) = (unsafe { library.get::<ListFn>(b"contract_list_scheduled_json\0") })
            else {
                continue;
            };
            let Ok(free) = (unsafe { library.get::<FreeFn>(b"contract_free\0") }) else {
                continue;
            };
            return Some(ScheduleAbi {
                declare: *declare,
                cancel: *cancel,
                list: *list,
                free: *free,
                _library: library,
            });
        }
        None
    })
    .as_ref()
}

fn declare_contract_schedule(task: &ScheduledTask, cwd: &std::path::Path) -> Option<String> {
    let prompt = CString::new(task.prompt.as_str()).ok()?;
    let cwd = CString::new(cwd.to_string_lossy().as_bytes()).ok()?;
    let first_due = task.next_fire_at().timestamp();
    let abi = schedule_abi()?;
    let ptr = unsafe {
        (abi.declare)(
            prompt.as_ptr(),
            cwd.as_ptr(),
            task.interval_secs,
            task.recurring,
            first_due,
        )
    };
    if ptr.is_null() {
        return None;
    }
    let id = unsafe { CStr::from_ptr(ptr) }
        .to_string_lossy()
        .into_owned();
    unsafe { (abi.free)(ptr) };
    Some(id)
}

pub(super) fn cancel_contract_schedule(id: &str) -> bool {
    let Some(abi) = schedule_abi() else {
        return false;
    };
    let Ok(id) = CString::new(id) else {
        return false;
    };
    unsafe { (abi.cancel)(id.as_ptr(), c"cancelled through scheduler_delete".as_ptr()) == 0 }
}

pub(super) fn list_contract_schedules() -> Vec<serde_json::Value> {
    let Some(abi) = schedule_abi() else {
        return Vec::new();
    };
    let ptr = unsafe { (abi.list)() };
    if ptr.is_null() {
        return Vec::new();
    }
    let raw = unsafe { CStr::from_ptr(ptr) }
        .to_string_lossy()
        .into_owned();
    unsafe { (abi.free)(ptr) };
    serde_json::from_str::<Vec<serde_json::Value>>(&raw).unwrap_or_default()
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerCreateOutput {
    pub id: String,
    pub human_schedule: String,
    pub recurring: bool,
}

impl xai_tool_runtime::ToolOutput for SchedulerCreateOutput {}

#[derive(Debug, Default)]
pub struct SchedulerCreateTool;

impl crate::types::tool_metadata::ToolMetadata for SchedulerCreateTool {
    fn kind(&self) -> ToolKind {
        ToolKind::Other
    }

    fn tool_namespace(&self) -> ToolNamespace {
        ToolNamespace::GrokBuild
    }

    fn description_template(&self) -> &str {
        r#"Create a scheduled task that runs a prompt on a recurring interval.

Set fire_immediately: true to also fire once on creation; by default the first run waits for the interval.

Usage notes:
- Interval format: "5m" (minutes), "2h" (hours), "1d" (days), "60s" (seconds, min 60)
- Maximum 50 scheduled tasks at once
- Recurring session-only tasks auto-expire after 7 days
- Set durable: true when the task must survive closing Aiko or restarting the machine"#
        // TODO: scheduler tools share ToolKind::Other so they can't be template-ized
        // via ${{ tools.by_kind.* }}. If tool name randomization is needed, add
        // dedicated ToolKind variants (SchedulerCreate, SchedulerDelete, SchedulerList).
    }

    fn emitted_notifications(&self) -> &'static [&'static str] {
        // A create call only registers the task (the actor emits
        // ScheduledTaskCreated). Fired/Removed come later from the actor timer,
        // delete, or shutdown — not from this tool's execution.
        &["ScheduledTaskCreated"]
    }

    fn requires_expr(&self) -> Expr<ToolRequirement> {
        Expr::True
    }
}

impl xai_tool_runtime::Tool for SchedulerCreateTool {
    type Args = SchedulerCreateInput;
    type Output = SchedulerCreateOutput;

    fn id(&self) -> xai_tool_protocol::ToolId {
        xai_tool_protocol::ToolId::new(SCHEDULER_CREATE_TOOL_NAME).expect("valid tool id")
    }

    fn description(
        &self,
        _ctx: &::xai_tool_runtime::ListToolsContext,
    ) -> xai_tool_types::ToolDescription {
        xai_tool_types::ToolDescription::new(
            "scheduler_create",
            crate::types::tool_metadata::ToolMetadata::description_template(self),
        )
    }

    fn capabilities(&self) -> xai_tool_protocol::ToolCapabilities {
        xai_tool_protocol::ToolCapabilities {
            is_read_only: false,
            tool_scope: Some(xai_tool_protocol::ToolScope::Write),
            ..Default::default()
        }
    }

    #[tracing::instrument(
        name = "tool.scheduler_create",
        skip_all,
        fields(interval = %input.interval)
    )]
    async fn run(
        &self,
        ctx: xai_tool_runtime::ToolCallContext,
        input: SchedulerCreateInput,
    ) -> Result<SchedulerCreateOutput, xai_tool_runtime::ToolError> {
        use crate::types::tool_metadata::shared_resources;
        let resources = shared_resources(&ctx)?;

        let interval_secs = parse_interval(&input.interval)
            .map_err(|e| xai_tool_runtime::ToolError::invalid_arguments(e.to_string()))?;

        let durable = input.durable.unwrap_or(false);
        let task = ScheduledTask::with_fire_immediately(
            interval_secs,
            input.prompt,
            input.recurring,
            durable,
            input.fire_immediately,
        );

        if durable {
            let cwd = {
                let res = resources.lock().await;
                res.get::<crate::types::resources::Cwd>()
                    .map(|cwd| cwd.0.clone())
            };
            if let Some(id) = cwd
                .as_deref()
                .and_then(|cwd| declare_contract_schedule(&task, cwd))
            {
                return Ok(SchedulerCreateOutput {
                    id,
                    human_schedule: interval_to_human(interval_secs),
                    recurring: input.recurring,
                });
            }
        }

        let sender = {
            let res = resources.lock().await;
            res.get::<SchedulerHandle>()
                .ok_or_else(|| {
                    xai_tool_runtime::ToolError::custom("missing_resource", "SchedulerHandle")
                })?
                .0
                .clone()
        };
        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
        sender
            .send(SchedulerCommand::Create {
                task: task.clone(),
                reply: reply_tx,
            })
            .map_err(|_| {
                xai_tool_runtime::ToolError::custom("process_manager", "Scheduler actor stopped")
            })?;

        let created = reply_rx
            .await
            .map_err(|_| {
                xai_tool_runtime::ToolError::custom(
                    "process_manager",
                    "Scheduler actor dropped reply",
                )
            })?
            .map_err(|e| xai_tool_runtime::ToolError::invalid_arguments(e.to_string()))?;

        Ok(SchedulerCreateOutput {
            id: created.id,
            human_schedule: interval_to_human(interval_secs),
            recurring: input.recurring,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loop_usage_message_has_no_host_default() {
        let usage = loop_usage_message();
        assert!(usage.contains("Usage: /loop"));
        assert!(
            !usage.contains("10m"),
            "usage must not claim a default: {usage}"
        );
    }

    #[test]
    fn loop_schedule_instruction_holds_invariants() {
        let args = "every 30 minutes do x";
        let instr = loop_schedule_instruction(args);
        assert!(
            !instr.contains("10m"),
            "instruction must not default: {instr}"
        );
        assert!(instr.contains("Deriving the interval"));
        assert!(instr.contains("<number><unit>"));
        assert!(instr.contains("ask the user how often"));
        assert!(instr.contains("Do NOT execute the prompt inline"));
        // Raw request forwarded verbatim for the model to parse.
        assert!(instr.contains(args));
    }
}
