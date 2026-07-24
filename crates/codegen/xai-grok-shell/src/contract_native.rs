//! Transparent bridge from Aiko turns into the local Contract ledger.
//!
//! Contract remains the row type and resolver substrate; Aiko is the only
//! user-facing verb. Every prompt is registered before it runs and is marked
//! satisfied only after the agent reaches a real end-of-turn verdict.

use agent_client_protocol as acp;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::ffi::{CStr, CString, c_char};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tokio::process::Command;
use xai_grok_tools::notification::{ScheduledTaskFired, ToolNotificationHandle};

mod activity_sensor;
mod contract_learning;
pub mod membrane;
mod reflex_policy;
mod skill_registry;

const LOCAL_COMMAND_TIMEOUT: Duration = Duration::from_millis(800);
const MAX_CONTEXT_BYTES: usize = 14_000;
const CONTEXT_DISABLED_ENV: &str = "AIKO_MACHINE_CONTEXT";
const TURN_FEEDBACK_LIMIT: usize = 8;
const DEFAULT_CONTRACT_MAX_DEPTH: u32 = 4;
const DEFAULT_CONTRACT_MAX_CHILDREN: u32 = 16;
const DEFAULT_CONTRACT_MAX_TOTAL_CHILDREN: u32 = 64;
const DEFAULT_CONTRACT_MAX_CONCURRENCY: u32 = 4;
/// Spine slots reserved by every turn expand (plasma-fractal node shape):
/// observe → agent:aiko → verify → posthook:feedback. Same contract row type
/// at every scale; bounds keep the loop from runaway fan-out.
const CELL_SPINE_LEN: usize = 4;

#[derive(Debug, Clone)]
pub struct TurnContract {
    id: String,
    goal: String,
    learning_family: Option<String>,
}

#[derive(Debug)]
pub struct GroundedTurn {
    pub prompt: Vec<acp::ContentBlock>,
    pub contract: Option<TurnContract>,
    pub capability_route: Option<serde_json::Value>,
}

/// Compact per-turn feedback card written to the ledger feedback log and
/// re-injected on later turns for granular score/outcome loops.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TurnFeedback {
    ts: String,
    goal: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    contract_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    proven_binary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    proven_score: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    proven_example: Option<String>,
    #[serde(default)]
    open_contracts: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    outcome: Option<String>,
}

type AbiVersionFn = unsafe extern "C" fn() -> u32;
type DeclareTurnFn = unsafe extern "C" fn(*const c_char, *const c_char) -> *mut c_char;
type DeclareTurnContextFn = unsafe extern "C" fn(*const c_char) -> *mut c_char;
type DeclareFn =
    unsafe extern "C" fn(*const c_char, *const c_char, *const c_char, *const c_char) -> *mut c_char;
type MarkSatisfiedFn = unsafe extern "C" fn(*const c_char, u32, *const c_char) -> i32;
type IterateFn = unsafe extern "C" fn(*const c_char, u32, i32, *const c_char) -> i32;
type RecommendCapabilitiesFn = unsafe extern "C" fn(*const c_char, *const c_char) -> *mut c_char;
type RegisterCapabilitiesFn = unsafe extern "C" fn(*const c_char, *const c_char) -> *mut c_char;
type ListCapabilitiesFn = unsafe extern "C" fn(*const c_char) -> *mut c_char;
type RecommendPlanFn = unsafe extern "C" fn(*const c_char, *const c_char, u32) -> *mut c_char;
type RecordObservationFn = unsafe extern "C" fn(*const c_char, *const c_char) -> *mut c_char;
type MuscleObserveFn =
    unsafe extern "C" fn(*const c_char, *const c_char, *const c_char, *const c_char, f64) -> bool;
type MuscleRecallFn = unsafe extern "C" fn(*const c_char) -> *mut c_char;
type MusclePredictFn = unsafe extern "C" fn(*const c_char, *const c_char) -> *mut c_char;
type MuscleRankFn =
    unsafe extern "C" fn(*const c_char, *const c_char, *const c_char, u32) -> *mut c_char;
type MuscleDeleteFn = unsafe extern "C" fn(*const c_char) -> bool;
type ReflexDecideFn = unsafe extern "C" fn(*const c_char) -> *mut c_char;
type DeclareScheduledJsonFn = unsafe extern "C" fn(*const c_char) -> *mut c_char;
type ExpandGraphFn = unsafe extern "C" fn(*const c_char) -> *mut c_char;
/// Learned proven-command router: returns JSON {binary, example, score, …}.
type RecommendProvenFn = unsafe extern "C" fn(*const c_char) -> *mut c_char;
type WarmRouterFn = unsafe extern "C" fn(u32) -> u32;
type FractalContextFn = unsafe extern "C" fn(*const c_char, *const c_char) -> *mut c_char;
type TickFn = unsafe extern "C" fn(*const c_char) -> *mut c_char;
type SettleExecutionFn = unsafe extern "C" fn(*const c_char) -> i32;
type EmitSignalFn = unsafe extern "C" fn(*const c_char) -> i32;
type RenewExecutionFn = unsafe extern "C" fn(*const c_char) -> i32;
type GetFn = unsafe extern "C" fn(*const c_char) -> *mut c_char;
type ListFn = unsafe extern "C" fn() -> *mut c_char;
type CancelFn = unsafe extern "C" fn(*const c_char, *const c_char) -> i32;
type RetryFn = unsafe extern "C" fn(*const c_char) -> i32;
type FreeFn = unsafe extern "C" fn(*mut c_char);

struct NativeContract {
    _library: libloading::Library,
    abi_version: u32,
    declare_turn: DeclareTurnFn,
    declare_turn_context: Option<DeclareTurnContextFn>,
    declare: DeclareFn,
    mark_satisfied: MarkSatisfiedFn,
    mark_grounded_satisfied: Option<MarkSatisfiedFn>,
    iterate: IterateFn,
    recommend_capabilities: RecommendCapabilitiesFn,
    register_capabilities: Option<RegisterCapabilitiesFn>,
    list_capabilities: Option<ListCapabilitiesFn>,
    recommend_plan: Option<RecommendPlanFn>,
    record_observation: Option<RecordObservationFn>,
    muscle_observe: Option<MuscleObserveFn>,
    muscle_recall: Option<MuscleRecallFn>,
    muscle_predict: Option<MusclePredictFn>,
    muscle_rank: Option<MuscleRankFn>,
    muscle_delete: Option<MuscleDeleteFn>,
    reflex_decide: Option<ReflexDecideFn>,
    declare_scheduled_json: Option<DeclareScheduledJsonFn>,
    expand_graph: Option<ExpandGraphFn>,
    recommend_proven: Option<RecommendProvenFn>,
    warm_router: WarmRouterFn,
    fractal_context: FractalContextFn,
    tick: Option<TickFn>,
    settle_execution: Option<SettleExecutionFn>,
    emit_signal: Option<EmitSignalFn>,
    renew_execution: Option<RenewExecutionFn>,
    get: GetFn,
    list: ListFn,
    cancel: Option<CancelFn>,
    retry: Option<RetryFn>,
    list_scheduled: Option<ListFn>,
    free: FreeFn,
}

impl NativeContract {
    fn library_names() -> &'static [&'static str] {
        #[cfg(target_os = "windows")]
        {
            &["contract.dll", "libcontract.dll"]
        }
        #[cfg(target_os = "macos")]
        {
            &["libcontract.dylib"]
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            &["libcontract.so"]
        }
    }

    fn candidates() -> Vec<PathBuf> {
        let mut paths = Vec::new();
        if let Some(path) = std::env::var_os("AIKO_CONTRACT_LIBRARY") {
            paths.push(path.into());
        }
        if let Ok(executable) = std::env::current_exe()
            && let Some(bin_dir) = executable.parent()
        {
            for name in Self::library_names() {
                paths.push(bin_dir.join("../lib").join(name));
                paths.push(bin_dir.join("../Resources/contract").join(name));
                paths.push(bin_dir.join("contract").join(name));
            }
        }
        if let Some(home) = dirs::home_dir() {
            for name in Self::library_names() {
                paths.push(home.join(".aiko/lib").join(name));
            }
        }
        for name in Self::library_names() {
            paths.push(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../../../contract/libcontract/zig-out/lib")
                    .join(name),
            );
        }
        paths
    }

    fn load() -> Option<Self> {
        for path in Self::candidates() {
            // SAFETY: every symbol is copied as a function pointer while the
            // owning Library is retained for the process lifetime.
            let Ok(library) = (unsafe { libloading::Library::new(path) }) else {
                continue;
            };
            let Ok(abi_version) =
                (unsafe { library.get::<AbiVersionFn>(b"contract_abi_version\0") })
            else {
                continue;
            };
            let abi_version = unsafe { abi_version() };
            if !(2..=6).contains(&abi_version) {
                continue;
            }
            let loaded = unsafe {
                Some(Self {
                    abi_version,
                    declare_turn: *library.get(b"contract_declare_turn\0").ok()?,
                    declare_turn_context: if abi_version >= 6 {
                        Some(*library.get(b"contract_declare_turn_context_json\0").ok()?)
                    } else {
                        None
                    },
                    declare: *library.get(b"contract_declare\0").ok()?,
                    mark_satisfied: *library.get(b"contract_mark_satisfied\0").ok()?,
                    mark_grounded_satisfied: if abi_version >= 6 {
                        Some(*library.get(b"contract_mark_grounded_satisfied\0").ok()?)
                    } else {
                        None
                    },
                    iterate: *library.get(b"contract_iterate\0").ok()?,
                    recommend_capabilities: *library
                        .get(b"contract_recommend_capabilities\0")
                        .ok()?,
                    register_capabilities: library
                        .get(b"contract_register_capabilities\0")
                        .ok()
                        .map(|symbol| *symbol),
                    list_capabilities: library
                        .get(b"contract_list_capabilities\0")
                        .ok()
                        .map(|symbol| *symbol),
                    recommend_plan: library
                        .get(b"contract_recommend_plan\0")
                        .ok()
                        .map(|symbol| *symbol),
                    record_observation: library
                        .get(b"contract_record_capability_observation\0")
                        .ok()
                        .map(|symbol| *symbol),
                    muscle_observe: if abi_version >= 4 {
                        Some(*library.get(b"contract_muscle_observe\0").ok()?)
                    } else {
                        None
                    },
                    muscle_recall: if abi_version >= 4 {
                        Some(*library.get(b"contract_muscle_recall\0").ok()?)
                    } else {
                        None
                    },
                    muscle_predict: if abi_version >= 4 {
                        Some(*library.get(b"contract_muscle_predict\0").ok()?)
                    } else {
                        None
                    },
                    muscle_rank: if abi_version >= 6 {
                        Some(*library.get(b"contract_muscle_rank_json\0").ok()?)
                    } else {
                        None
                    },
                    muscle_delete: if abi_version >= 6 {
                        Some(*library.get(b"contract_muscle_delete\0").ok()?)
                    } else {
                        None
                    },
                    reflex_decide: if abi_version >= 6 {
                        Some(*library.get(b"contract_reflex_decide_json\0").ok()?)
                    } else {
                        None
                    },
                    declare_scheduled_json: if abi_version >= 6 {
                        Some(*library.get(b"contract_declare_scheduled_json\0").ok()?)
                    } else {
                        None
                    },
                    expand_graph: if abi_version >= 5 {
                        Some(*library.get(b"contract_expand_json\0").ok()?)
                    } else {
                        None
                    },
                    recommend_proven: library.get(b"contract_recommend\0").ok().map(|s| *s),
                    warm_router: *library.get(b"contract_warm_router\0").ok()?,
                    fractal_context: *library.get(b"contract_get_fractal_context\0").ok()?,
                    tick: if abi_version >= 3 {
                        Some(*library.get(b"contract_tick_json\0").ok()?)
                    } else {
                        None
                    },
                    settle_execution: if abi_version >= 3 {
                        Some(*library.get(b"contract_settle_execution_json\0").ok()?)
                    } else {
                        None
                    },
                    emit_signal: if abi_version >= 3 {
                        Some(*library.get(b"contract_emit_signal_json\0").ok()?)
                    } else {
                        None
                    },
                    renew_execution: if abi_version >= 3 {
                        Some(*library.get(b"contract_renew_execution_json\0").ok()?)
                    } else {
                        None
                    },
                    get: *library.get(b"contract_get\0").ok()?,
                    list: *library.get(b"contract_list\0").ok()?,
                    cancel: if abi_version >= 3 {
                        Some(*library.get(b"contract_cancel\0").ok()?)
                    } else {
                        None
                    },
                    retry: if abi_version >= 3 {
                        Some(*library.get(b"contract_retry\0").ok()?)
                    } else {
                        None
                    },
                    list_scheduled: if abi_version >= 3 {
                        Some(*library.get(b"contract_list_scheduled_json\0").ok()?)
                    } else {
                        None
                    },
                    free: *library.get(b"contract_free\0").ok()?,
                    _library: library,
                })
            };
            if loaded.is_some() {
                return loaded;
            }
        }
        None
    }

    fn take_string(&self, ptr: *mut c_char) -> Option<String> {
        if ptr.is_null() {
            return None;
        }
        // SAFETY: libcontract returns a NUL-terminated allocation owned until
        // contract_free is called below.
        let value = unsafe { CStr::from_ptr(ptr) }
            .to_string_lossy()
            .into_owned();
        unsafe { (self.free)(ptr) };
        Some(value)
    }

    fn declare(&self, goal: &str, cwd: &Path) -> Option<String> {
        let goal = CString::new(goal).ok()?;
        let cwd = CString::new(cwd.to_string_lossy().as_bytes()).ok()?;
        self.take_string(unsafe { (self.declare_turn)(goal.as_ptr(), cwd.as_ptr()) })
    }

    fn declare_context<T: Serialize>(&self, request: &T) -> Option<Value> {
        let declare = self.declare_turn_context?;
        let request = CString::new(serde_json::to_vec(request).ok()?).ok()?;
        let raw = self.take_string(unsafe { declare(request.as_ptr()) })?;
        serde_json::from_str(&raw).ok()
    }

    fn declare_child(&self, plan: &str, action: &str, parent_id: &str) -> Option<String> {
        let plan = CString::new(plan).ok()?;
        let action = CString::new(action).ok()?;
        let parent_id = CString::new(parent_id).ok()?;
        let agent = c"aiko-native";
        self.take_string(unsafe {
            (self.declare)(
                plan.as_ptr(),
                action.as_ptr(),
                parent_id.as_ptr(),
                agent.as_ptr(),
            )
        })
    }

    fn satisfy(&self, id: &str) -> bool {
        self.satisfy_with_proof(id, "aiko:end-turn")
    }

    fn satisfy_with_proof(&self, id: &str, proof: &str) -> bool {
        let Ok(id) = CString::new(id) else {
            return false;
        };
        let Ok(proof) = CString::new(proof) else {
            return false;
        };
        unsafe { (self.mark_satisfied)(id.as_ptr(), 0, proof.as_ptr()) == 0 }
    }

    fn satisfy_grounded(&self, id: &str) -> bool {
        let Some(mark) = self.mark_grounded_satisfied else {
            return self.satisfy(id);
        };
        let Ok(id) = CString::new(id) else {
            return false;
        };
        let proof = c"aiko:end-turn:grounded-children";
        unsafe { mark(id.as_ptr(), 0, proof.as_ptr()) == 0 }
    }

    fn fail(&self, id: &str, reason: &str) -> bool {
        let Ok(id) = CString::new(id) else {
            return false;
        };
        let Ok(reason) = CString::new(reason) else {
            return false;
        };
        unsafe { (self.iterate)(id.as_ptr(), 0, 1, reason.as_ptr()) == 0 }
    }

    fn recommend_capabilities(
        &self,
        goal: &str,
        availability_json: &str,
    ) -> Option<serde_json::Value> {
        let goal = CString::new(goal).ok()?;
        let availability = CString::new(availability_json).ok()?;
        let raw = self.take_string(unsafe {
            (self.recommend_capabilities)(goal.as_ptr(), availability.as_ptr())
        })?;
        serde_json::from_str(&raw).ok()
    }

    fn register_capabilities<T: Serialize>(&self, source: &str, descriptors: &T) -> Option<Value> {
        let register = self.register_capabilities?;
        let source = CString::new(source).ok()?;
        let descriptors = CString::new(serde_json::to_vec(descriptors).ok()?).ok()?;
        let raw = self.take_string(unsafe { register(source.as_ptr(), descriptors.as_ptr()) })?;
        serde_json::from_str(&raw).ok()
    }

    fn list_capabilities(&self, source: Option<&str>) -> Option<Value> {
        let list = self.list_capabilities?;
        let filter = source.map_or_else(
            || serde_json::json!({}),
            |source| serde_json::json!({ "source": source }),
        );
        let filter = CString::new(filter.to_string()).ok()?;
        let raw = self.take_string(unsafe { list(filter.as_ptr()) })?;
        serde_json::from_str(&raw).ok()
    }

    fn recommend_plan<T: Serialize>(
        &self,
        goal: &str,
        availability: &T,
        limit: u32,
    ) -> Option<Value> {
        let recommend = self.recommend_plan?;
        let goal = CString::new(goal).ok()?;
        let availability = CString::new(serde_json::to_vec(availability).ok()?).ok()?;
        let raw = self.take_string(unsafe {
            recommend(goal.as_ptr(), availability.as_ptr(), limit.clamp(1, 3))
        })?;
        serde_json::from_str(&raw).ok()
    }

    fn record_observation<T: Serialize>(&self, context: &str, observation: &T) -> Option<Value> {
        let record = self.record_observation?;
        let context = CString::new(context).ok()?;
        let observation = CString::new(serde_json::to_vec(observation).ok()?).ok()?;
        let raw = self.take_string(unsafe { record(context.as_ptr(), observation.as_ptr()) })?;
        serde_json::from_str(&raw).ok()
    }

    fn observe_muscle(
        &self,
        context: &str,
        binary: &str,
        before: &str,
        after: &str,
        reward: f64,
    ) -> bool {
        let Some(observe) = self.muscle_observe else {
            return false;
        };
        let Ok(context) = CString::new(context) else {
            return false;
        };
        let Ok(binary) = CString::new(binary) else {
            return false;
        };
        let Ok(before) = CString::new(before) else {
            return false;
        };
        let Ok(after) = CString::new(after) else {
            return false;
        };
        unsafe {
            observe(
                context.as_ptr(),
                binary.as_ptr(),
                before.as_ptr(),
                after.as_ptr(),
                reward.clamp(-1.0, 1.0),
            )
        }
    }

    #[allow(dead_code)]
    fn recall_muscle(&self, context: &str) -> Option<String> {
        let recall = self.muscle_recall?;
        let context = CString::new(context).ok()?;
        self.take_string(unsafe { recall(context.as_ptr()) })
    }

    #[allow(dead_code)]
    fn predict_muscle(&self, before: &str, target: &str) -> Option<String> {
        let predict = self.muscle_predict?;
        let before = CString::new(before).ok()?;
        let target = CString::new(target).ok()?;
        self.take_string(unsafe { predict(before.as_ptr(), target.as_ptr()) })
    }

    fn rank_muscle(
        &self,
        context: &str,
        before: Option<&str>,
        target: Option<&str>,
    ) -> Option<Value> {
        let rank = self.muscle_rank?;
        let context = CString::new(context).ok()?;
        let before = before.map(CString::new).transpose().ok()?;
        let target = target.map(CString::new).transpose().ok()?;
        let raw = self.take_string(unsafe {
            rank(
                context.as_ptr(),
                before
                    .as_ref()
                    .map_or(std::ptr::null(), |value| value.as_ptr()),
                target
                    .as_ref()
                    .map_or(std::ptr::null(), |value| value.as_ptr()),
                8,
            )
        })?;
        serde_json::from_str(&raw).ok()
    }

    fn delete_muscle(&self, binary: &str) -> bool {
        let Some(delete) = self.muscle_delete else {
            return false;
        };
        let Ok(binary) = CString::new(binary) else {
            return false;
        };
        unsafe { delete(binary.as_ptr()) }
    }

    fn decide_reflex<T: Serialize>(&self, request: &T) -> Option<Value> {
        let decide = self.reflex_decide?;
        let request = CString::new(serde_json::to_vec(request).ok()?).ok()?;
        let raw = self.take_string(unsafe { decide(request.as_ptr()) })?;
        serde_json::from_str(&raw).ok()
    }

    fn declare_scheduled<T: Serialize>(&self, request: &T) -> Option<Value> {
        let declare = self.declare_scheduled_json?;
        let request = CString::new(serde_json::to_vec(request).ok()?).ok()?;
        let raw = self.take_string(unsafe { declare(request.as_ptr()) })?;
        serde_json::from_str(&raw).ok()
    }

    #[allow(dead_code)]
    fn expand_graph<T: Serialize>(&self, request: &T) -> Option<Value> {
        let expand = self.expand_graph?;
        let request = CString::new(serde_json::to_vec(request).ok()?).ok()?;
        let raw = self.take_string(unsafe { expand(request.as_ptr()) })?;
        serde_json::from_str(&raw).ok()
    }

    /// Nearest proven command for a goal (`contract recommend`).
    fn recommend_proven(&self, goal: &str) -> Option<serde_json::Value> {
        let recommend = self.recommend_proven?;
        let goal = CString::new(goal).ok()?;
        let raw = self.take_string(unsafe { recommend(goal.as_ptr()) })?;
        serde_json::from_str(&raw).ok()
    }

    fn fractal_context(&self, id: &str, event: &str) -> Option<serde_json::Value> {
        let id = CString::new(id).ok()?;
        let event = CString::new(event).ok()?;
        let raw =
            self.take_string(unsafe { (self.fractal_context)(id.as_ptr(), event.as_ptr()) })?;
        serde_json::from_str(&raw).ok()
    }

    fn warm(&self, passes: u32) -> u32 {
        unsafe { (self.warm_router)(passes) }
    }

    fn tick(&self, request: &ContractTickRequest<'_>) -> Option<ContractTick> {
        let tick = self.tick?;
        let request = serde_json::to_string(request).ok()?;
        let request = CString::new(request).ok()?;
        let raw = self.take_string(unsafe { tick(request.as_ptr()) })?;
        let response: ContractTick = serde_json::from_str(&raw).ok()?;
        (response.abi_version == self.abi_version).then_some(response)
    }

    fn settle(&self, request: &ContractSettlement<'_>) -> bool {
        let Some(settle) = self.settle_execution else {
            return false;
        };
        let Ok(request) = serde_json::to_string(request) else {
            return false;
        };
        let Ok(request) = CString::new(request) else {
            return false;
        };
        unsafe { settle(request.as_ptr()) == 0 }
    }

    fn emit_signal(&self, request: &ContractSignal<'_>) -> bool {
        let Some(emit) = self.emit_signal else {
            return false;
        };
        let Ok(request) = serde_json::to_string(request) else {
            return false;
        };
        let Ok(request) = CString::new(request) else {
            return false;
        };
        unsafe { emit(request.as_ptr()) == 0 }
    }

    fn renew(&self, request: &ContractRenewal<'_>) -> bool {
        let Some(renew) = self.renew_execution else {
            return false;
        };
        let Ok(request) = serde_json::to_string(request) else {
            return false;
        };
        let Ok(request) = CString::new(request) else {
            return false;
        };
        unsafe { renew(request.as_ptr()) == 0 }
    }

    fn get(&self, id: &str) -> Option<String> {
        let id = CString::new(id).ok()?;
        self.take_string(unsafe { (self.get)(id.as_ptr()) })
    }

    fn list(&self) -> Option<String> {
        self.take_string(unsafe { (self.list)() })
    }

    fn cancel(&self, id: &str) -> bool {
        let Some(cancel) = self.cancel else {
            return false;
        };
        let Ok(id) = CString::new(id) else {
            return false;
        };
        unsafe { cancel(id.as_ptr(), c"cancelled by user".as_ptr()) == 0 }
    }

    fn retry(&self, id: &str) -> bool {
        let Some(retry) = self.retry else {
            return false;
        };
        let Ok(id) = CString::new(id) else {
            return false;
        };
        unsafe { retry(id.as_ptr()) == 0 }
    }

    fn list_scheduled(&self) -> Option<Value> {
        let list = self.list_scheduled?;
        let raw = self.take_string(unsafe { list() })?;
        serde_json::from_str(&raw).ok()
    }
}

#[derive(Debug, Serialize)]
struct ContractTickRequest<'a> {
    owner: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    cwd: Option<&'a str>,
    max_items: usize,
    lease_seconds: u32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ContractClaim {
    pub contract_id: String,
    pub occurrence: String,
    pub prompt: String,
    pub cwd: String,
    pub due_unix: i64,
    pub lease_until_unix: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ContractTick {
    abi_version: u32,
    pub now_unix: i64,
    pub next_wake_unix: Option<i64>,
    pub claims: Vec<ContractClaim>,
}

#[derive(Debug, Serialize)]
struct ContractSettlement<'a> {
    owner: &'a str,
    contract_id: &'a str,
    occurrence: &'a str,
    outcome: &'a str,
    detail: &'a str,
}

#[derive(Debug, Serialize)]
struct ContractSignal<'a> {
    name: &'a str,
    cwd: &'a str,
    detail: &'a str,
}

#[derive(Debug, Serialize)]
struct ContractRenewal<'a> {
    owner: &'a str,
    contract_id: &'a str,
    occurrence: &'a str,
    lease_seconds: u32,
}

fn native_contract() -> Option<&'static NativeContract> {
    static INSTANCE: OnceLock<Option<NativeContract>> = OnceLock::new();
    INSTANCE.get_or_init(NativeContract::load).as_ref()
}

/// Negotiated native Contract ABI, if a compatible runtime is available.
pub fn contract_abi_version() -> Option<u32> {
    native_contract().map(|contract| contract.abi_version)
}

/// Lease due durable work from Contract without invoking its CLI.
pub async fn tick_due_contracts(
    owner: String,
    cwd: Option<PathBuf>,
    max_items: usize,
    lease_seconds: u32,
) -> Option<ContractTick> {
    tokio::task::spawn_blocking(move || {
        let cwd = cwd.as_deref().map(|path| path.to_string_lossy());
        native_contract()?.tick(&ContractTickRequest {
            owner: &owner,
            cwd: cwd.as_deref(),
            max_items,
            lease_seconds,
        })
    })
    .await
    .ok()
    .flatten()
}

/// Persist the execution outcome for a previously leased occurrence.
pub async fn settle_contract_claim(
    owner: String,
    claim: ContractClaim,
    outcome: &'static str,
    detail: String,
) -> bool {
    tokio::task::spawn_blocking(move || {
        native_contract().is_some_and(|contract| {
            contract.settle(&ContractSettlement {
                owner: &owner,
                contract_id: &claim.contract_id,
                occurrence: &claim.occurrence,
                outcome,
                detail: &detail,
            })
        })
    })
    .await
    .unwrap_or(false)
}

/// Emit a privacy-safe application/system event into Contract's native
/// trigger ledger.
pub async fn emit_contract_signal(name: String, cwd: PathBuf, detail: String) -> bool {
    tokio::task::spawn_blocking(move || {
        native_contract().is_some_and(|contract| {
            contract.emit_signal(&ContractSignal {
                name: &name,
                cwd: &cwd.to_string_lossy(),
                detail: &detail,
            })
        })
    })
    .await
    .unwrap_or(false)
}

async fn renew_contract_claim(owner: String, claim: ContractClaim, lease_seconds: u32) -> bool {
    tokio::task::spawn_blocking(move || {
        native_contract().is_some_and(|contract| {
            contract.renew(&ContractRenewal {
                owner: &owner,
                contract_id: &claim.contract_id,
                occurrence: &claim.occurrence,
                lease_seconds,
            })
        })
    })
    .await
    .unwrap_or(false)
}

pub async fn inspect_contract(id: String) -> Option<String> {
    tokio::task::spawn_blocking(move || native_contract()?.get(&id))
        .await
        .ok()
        .flatten()
}

pub async fn list_contracts() -> Vec<(String, String)> {
    tokio::task::spawn_blocking(move || {
        let raw = native_contract()?.list()?;
        Some(
            raw.lines()
                .filter_map(|line| {
                    let (id, plan) = line.split_once('\t')?;
                    Some((id.to_string(), plan.to_string()))
                })
                .collect::<Vec<_>>(),
        )
    })
    .await
    .ok()
    .flatten()
    .unwrap_or_default()
}

pub async fn cancel_contract(id: String) -> bool {
    tokio::task::spawn_blocking(move || {
        native_contract().is_some_and(|contract| contract.cancel(&id))
    })
    .await
    .unwrap_or(false)
}

pub async fn retry_contract(id: String) -> bool {
    tokio::task::spawn_blocking(move || {
        native_contract().is_some_and(|contract| contract.retry(&id))
    })
    .await
    .unwrap_or(false)
}

pub async fn list_scheduled_contracts() -> Value {
    tokio::task::spawn_blocking(move || native_contract()?.list_scheduled())
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| Value::Array(Vec::new()))
}

pub async fn inspect_muscle_rankings(context: String) -> Value {
    tokio::task::spawn_blocking(move || native_contract()?.rank_muscle(&context, None, None))
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| json!({ "count": 0, "candidates": [] }))
}

pub async fn delete_muscle_reflex(binary: String) -> bool {
    tokio::task::spawn_blocking(move || {
        native_contract().is_some_and(|native| native.delete_muscle(&binary))
    })
    .await
    .unwrap_or(false)
}

pub fn reflex_policy_status() -> Value {
    serde_json::to_value(reflex_policy::load()).unwrap_or_else(|_| json!({}))
}

pub fn set_reflexes_enabled(enabled: bool) -> Result<Value, String> {
    reflex_policy::update(|policy| policy.reflexes_enabled = enabled)
        .and_then(|policy| serde_json::to_value(policy).map_err(std::io::Error::other))
        .map_err(|error| error.to_string())
}

pub fn set_activity_sensors_enabled(enabled: bool) -> Result<Value, String> {
    reflex_policy::update(|policy| policy.activity_sensors_enabled = enabled)
        .and_then(|policy| serde_json::to_value(policy).map_err(std::io::Error::other))
        .map_err(|error| error.to_string())
}

pub fn set_reflex_capability_enabled(capability: String, enabled: bool) -> Result<Value, String> {
    if capability.is_empty() || capability.len() > 128 {
        return Err("invalid capability name".into());
    }
    reflex_policy::update(|policy| {
        policy.capabilities.insert(capability, enabled);
    })
    .and_then(|policy| serde_json::to_value(policy).map_err(std::io::Error::other))
    .map_err(|error| error.to_string())
}

pub fn set_activity_application_excluded(
    application: String,
    excluded: bool,
) -> Result<Value, String> {
    if application.is_empty() || application.len() > 256 {
        return Err("invalid application name".into());
    }
    reflex_policy::update(|policy| {
        if excluded {
            policy.excluded_applications.insert(application.clone());
        } else {
            policy.excluded_applications.remove(&application);
        }
    })
    .and_then(|policy| serde_json::to_value(policy).map_err(std::io::Error::other))
    .map_err(|error| error.to_string())
}

pub fn inspect_activity_events(limit: usize) -> Value {
    activity_sensor::inspect(limit)
}

pub fn clear_activity_events() -> Result<(), String> {
    activity_sensor::clear().map_err(|error| error.to_string())
}

pub fn decide_reflex(
    capability: &str,
    successes: u64,
    failures: u64,
    confidence: f64,
    effect_scope: &str,
    authority: bool,
    reversible: bool,
    read_only: bool,
    estimated_cost: f64,
) -> Value {
    let policy = reflex_policy::load();
    let request = json!({
        "enabled": policy.reflexes_enabled,
        "capability_enabled": policy.capabilities.get(capability).copied().unwrap_or(false),
        "successes": successes,
        "failures": failures,
        "confidence": confidence,
        "effect_scope": effect_scope,
        "authority": authority,
        "reversible": reversible,
        "read_only": read_only,
        "estimated_cost": estimated_cost,
        "max_cost": policy.max_automatic_cost,
    });
    native_contract()
        .and_then(|native| native.decide_reflex(&request))
        .unwrap_or_else(|| json!({ "decision": "hold", "reason": "native_policy_unavailable" }))
}

#[derive(Debug, Clone)]
struct PendingContractClaim {
    owner: String,
    claim: ContractClaim,
}

fn pending_contract_claims() -> &'static Mutex<HashMap<String, PendingContractClaim>> {
    static CLAIMS: OnceLock<Mutex<HashMap<String, PendingContractClaim>>> = OnceLock::new();
    CLAIMS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn contract_task_id(claim: &ContractClaim) -> String {
    let occurrence = claim
        .occurrence
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect::<String>();
    format!("contract-{}-{occurrence}", claim.contract_id)
}

/// Start the session-scoped host loop for Contract's durable resolver.
///
/// The weak session reference is the lifetime boundary: this task cannot keep
/// a closed session or its notification bridge alive.
pub(crate) fn spawn_contract_coordinator(
    owner: String,
    cwd: PathBuf,
    notification_handle: ToolNotificationHandle,
    session: std::sync::Weak<crate::session::acp_session::SessionActor>,
) {
    tokio::task::spawn_local(async move {
        loop {
            if session.upgrade().is_none() {
                let abandoned = pending_contract_claims()
                    .lock()
                    .map(|mut pending| {
                        let task_ids = pending
                            .iter()
                            .filter(|(_, item)| item.owner == owner)
                            .map(|(task_id, _)| task_id.clone())
                            .collect::<Vec<_>>();
                        task_ids
                            .into_iter()
                            .filter_map(|task_id| pending.remove(&task_id))
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                for pending in abandoned {
                    let _ = settle_contract_claim(
                        pending.owner,
                        pending.claim,
                        "retry",
                        "Aiko session closed before the ContractWake completed".to_string(),
                    )
                    .await;
                }
                break;
            }

            let now_unix = chrono::Utc::now().timestamp();
            let renewals = pending_contract_claims()
                .lock()
                .map(|pending| {
                    pending
                        .iter()
                        .filter(|(_, item)| {
                            item.owner == owner
                                && item.claim.lease_until_unix.saturating_sub(now_unix) <= 900
                        })
                        .map(|(task_id, item)| (task_id.clone(), item.claim.clone()))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            for (task_id, claim) in renewals {
                if renew_contract_claim(owner.clone(), claim, 3_600).await
                    && let Ok(mut pending) = pending_contract_claims().lock()
                    && let Some(item) = pending.get_mut(&task_id)
                {
                    item.claim.lease_until_unix = now_unix.saturating_add(3_600);
                }
            }

            let Some(tick) = tick_due_contracts(owner.clone(), Some(cwd.clone()), 32, 3_600).await
            else {
                // ABI v2 is supported for foreground turns but has no durable
                // tick surface. Re-check infrequently in case the runtime is
                // replaced before this process exits.
                tokio::time::sleep(Duration::from_secs(30)).await;
                continue;
            };

            for claim in tick.claims {
                let task_id = contract_task_id(&claim);
                let prompt = claim.prompt.trim();
                if prompt.is_empty() {
                    let _ = settle_contract_claim(
                        owner.clone(),
                        claim,
                        "retry",
                        "contract occurrence has no executable prompt".to_string(),
                    )
                    .await;
                    continue;
                }
                if let Ok(mut pending) = pending_contract_claims().lock() {
                    pending.insert(
                        task_id.clone(),
                        PendingContractClaim {
                            owner: owner.clone(),
                            claim: claim.clone(),
                        },
                    );
                }
                notification_handle.send_scheduled_task_fired(ScheduledTaskFired {
                    task_id,
                    prompt: prompt.to_string(),
                    human_schedule: format!("Contract {}", claim.occurrence),
                    next_fire_at: tick.next_wake_unix.and_then(|unix| {
                        chrono::DateTime::<chrono::Utc>::from_timestamp(unix, 0)
                            .map(|deadline| deadline.to_rfc3339())
                    }),
                });
            }

            let delay_seconds = tick
                .next_wake_unix
                .map(|deadline| deadline.saturating_sub(tick.now_unix).max(0) as u64)
                .unwrap_or(5)
                // Polling at least every five seconds also notices newly
                // declared contracts whose deadline predates the prior tick.
                .min(5);
            tokio::time::sleep(Duration::from_secs(delay_seconds.max(1))).await;
        }
    });
}

fn take_claim_for_prompt(prompt_id: &str) -> Option<PendingContractClaim> {
    let mut pending = pending_contract_claims().lock().ok()?;
    let task_id = pending
        .keys()
        .find(|task_id| {
            prompt_id
                .strip_prefix("contract-wake-")
                .or_else(|| prompt_id.strip_prefix("scheduler-fired-"))
                .is_some_and(|rest| rest.starts_with(&format!("{task_id}-")))
        })
        .cloned()?;
    pending.remove(&task_id)
}

/// Settle a Contract-backed synthetic turn at Aiko's owned-completion
/// chokepoint. Failed/cancelled turns release the occurrence for retry.
pub(crate) async fn settle_contract_prompt(prompt_id: &str, succeeded: bool, detail: &str) -> bool {
    let Some(pending) = take_claim_for_prompt(prompt_id) else {
        return false;
    };
    settle_contract_claim(
        pending.owner,
        pending.claim,
        if succeeded { "satisfied" } else { "retry" },
        detail.to_string(),
    )
    .await
}

pub(crate) fn warm_router_background(passes: u32) {
    static WARMING: AtomicBool = AtomicBool::new(false);
    if WARMING.swap(true, Ordering::AcqRel) {
        return;
    }
    let Ok(runtime) = tokio::runtime::Handle::try_current() else {
        WARMING.store(false, Ordering::Release);
        return;
    };
    runtime.spawn_blocking(move || {
        if let Some(contract) = native_contract() {
            let _ = contract.warm(passes.max(1));
        }
        WARMING.store(false, Ordering::Release);
    });
}

pub(crate) fn background_worker_installed() -> bool {
    #[cfg(target_os = "macos")]
    {
        dirs::home_dir().is_some_and(|home| {
            home.join("Library/LaunchAgents/net.theclarityproject.aiko.contract-worker.plist")
                .is_file()
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

fn pending_capability_routes() -> &'static Mutex<HashMap<String, serde_json::Value>> {
    static ROUTES: OnceLock<Mutex<HashMap<String, serde_json::Value>>> = OnceLock::new();
    ROUTES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn pending_contract_roots() -> &'static Mutex<HashMap<String, String>> {
    static ROOTS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    ROOTS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn store_turn_contract_root(prompt_id: &str, root_id: Option<&str>) {
    let Ok(mut roots) = pending_contract_roots().lock() else {
        return;
    };
    if let Some(root_id) = root_id.filter(|id| valid_contract_id(id)) {
        roots.insert(prompt_id.to_owned(), root_id.to_owned());
    } else {
        roots.remove(prompt_id);
    }
}

pub fn take_turn_contract_root(prompt_id: &str) -> Option<String> {
    pending_contract_roots().lock().ok()?.remove(prompt_id)
}

/// Bridge a recommendation across the session command queue without putting
/// routing policy into the prompt ABI. Prompt ids are unique and the entry is
/// consumed exactly once by `SessionActor::handle_prompt`.
pub fn store_capability_route(prompt_id: &str, route: Option<serde_json::Value>) {
    let Ok(mut routes) = pending_capability_routes().lock() else {
        return;
    };
    if let Some(route) = route {
        routes.insert(prompt_id.to_owned(), route);
    } else {
        routes.remove(prompt_id);
    }
}

pub fn take_capability_route(prompt_id: &str) -> Option<serde_json::Value> {
    pending_capability_routes().lock().ok()?.remove(prompt_id)
}

fn goal_from_blocks(blocks: &[acp::ContentBlock]) -> Option<String> {
    let goal = blocks
        .iter()
        .filter_map(|block| match block {
            acp::ContentBlock::Text(text) => Some(text.text.trim()),
            _ => None,
        })
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let goal = clean_goal(&goal);
    (!goal.is_empty()).then_some(goal)
}

/// Strip desktop/session guide appends and system-reminder chrome so ledger
/// plans and recommend queries stay goal-shaped (not multi-kb registry dumps).
fn clean_goal(raw: &str) -> String {
    let mut goal = raw;
    // Desktop used to append "---\n## Generative UI …" into the user prompt.
    const CUTS: &[&str] = &[
        "\n---\n## Generative UI",
        "\n---\n## Generative UI registry",
        "\n\n---\n## Generative UI",
        "<system-reminder>",
        "\n## Generative UI (durable json-render)",
        "\n## Generative UI registry (json-render",
    ];
    for cut in CUTS {
        if let Some(idx) = goal.find(cut) {
            goal = &goal[..idx];
        }
    }
    goal.trim().to_string()
}

/// Register a prompt in the canonical local ledger. This is deliberately
/// best-effort: ledger bookkeeping must never prevent Aiko from doing the work.
pub async fn declare_turn(blocks: &[acp::ContentBlock], cwd: &Path) -> Option<TurnContract> {
    let goal = goal_from_blocks(blocks)?;
    // A stateless worker is executing a child that was already materialized by
    // its parent. Adopt that canonical identity rather than declaring a second,
    // disconnected turn row for the same work.
    if let (Ok(id), Ok(parent_id)) = (
        std::env::var("AIKO_CONTRACT_ID"),
        std::env::var("AIKO_CONTRACT_PARENT_ID"),
    ) {
        if valid_contract_id(&id) && valid_contract_id(&parent_id) {
            return Some(TurnContract {
                id,
                goal,
                learning_family: None,
            });
        }
    }
    let goal_for_declare = goal.clone();
    let cwd = cwd.to_owned();
    let parent_id = std::env::var("AIKO_CONTRACT_PARENT_ID")
        .ok()
        .filter(|id| valid_contract_id(id));
    let root_id = std::env::var("AIKO_CONTRACT_ROOT_ID")
        .ok()
        .filter(|id| valid_contract_id(id));
    let depth = bounded_env_u32("AIKO_CONTRACT_DEPTH", 0, 16);
    let max_depth = bounded_env_u32("AIKO_CONTRACT_MAX_DEPTH", DEFAULT_CONTRACT_MAX_DEPTH, 16);
    let max_children = bounded_env_u32(
        "AIKO_CONTRACT_MAX_CHILDREN",
        DEFAULT_CONTRACT_MAX_CHILDREN,
        16,
    );
    let max_total_children = bounded_env_u32(
        "AIKO_CONTRACT_MAX_TOTAL_CHILDREN",
        DEFAULT_CONTRACT_MAX_TOTAL_CHILDREN,
        128,
    );
    let max_concurrency = bounded_env_u32(
        "AIKO_CONTRACT_MAX_CONCURRENCY",
        DEFAULT_CONTRACT_MAX_CONCURRENCY,
        16,
    );
    if depth > 0 && (parent_id.is_none() || root_id.is_none()) {
        tracing::warn!(depth, "refusing disconnected Contract descendant");
        return None;
    }
    let id = tokio::task::spawn_blocking(move || {
        let native = native_contract()?;
        let request = json!({
            "plan": &goal_for_declare,
            "cwd": cwd.to_string_lossy(),
            "parent_id": parent_id,
            "root_id": root_id,
            "depth": depth,
            "max_depth": max_depth,
            "max_children": max_children,
            "max_total_children": max_total_children,
            "max_concurrency": max_concurrency,
        });
        native
            .declare_context(&request)
            .and_then(|value| value.get("id")?.as_str().map(str::to_owned))
            .or_else(|| native.declare(&goal_for_declare, &cwd))
    })
    .await
    .ok()
    .flatten()?;
    if id.len() == 8 && id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Some(TurnContract {
            id,
            goal,
            learning_family: None,
        })
    } else {
        tracing::debug!(raw_id = %id, "contract returned an invalid row id");
        None
    }
}

fn valid_contract_id(id: &str) -> bool {
    id.len() == 8 && id.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn bounded_env_u32(name: &str, default: u32, maximum: u32) -> u32 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(default)
        .min(maximum)
}

/// Fractal cell spine: one contract primitive, recursive self-organization.
/// Shape mirrors plasma-ai/fractal (hierarchical agent loops, hard caps) but
/// every node is a contract row — no second substrate.
///
///   observe  →  agent:aiko  →  verify  →  posthook:feedback
///                  ↑___________________________|
///              (ledger feedback re-enters next wave / next turn)
fn cell_spine_children(goal: &str) -> Vec<Value> {
    vec![
        json!({
            "key": "observe",
            "plan": format!("Observe privacy-safe current state and relevant evidence for: {goal}"),
            "action": "contract:observe_state",
            "authorization": "approved",
        }),
        json!({
            "key": "agent",
            "plan": format!("Aiko agent executes the cell goal (stateless worker, parent-pointed): {goal}"),
            "action": "agent:aiko",
            "depends_on": ["observe"],
            "authorization": "approved",
        }),
        json!({
            "key": "verify",
            "plan": format!("Verify externally grounded outcomes for: {goal}"),
            "action": "contract:verify",
            "depends_on": ["agent"],
            "authorization": "approved",
        }),
        json!({
            "key": "feedback",
            "plan": format!(
                "Close the feedback loop: record outcome, residual, and next-wave pointers for: {goal}"
            ),
            "action": "posthook:feedback",
            "depends_on": ["verify"],
            "authorization": "approved",
        }),
    ]
}

/// Build the full expand child list: spine + skill DAG nodes, bounded so total
/// never exceeds `max_children` (muscle.MAX_PARALLEL / env cap).
fn cell_expand_children(goal: &str, skill_children: Vec<Value>, max_children: usize) -> Vec<Value> {
    let mut children = cell_spine_children(goal);
    let room = max_children.saturating_sub(children.len());
    for child in skill_children.into_iter().take(room) {
        // Skill nodes hang off observe so they wave-parallel with agent when
        // independent; effect-gated nodes keep their own depends_on.
        let mut child = child;
        if child
            .get("depends_on")
            .and_then(Value::as_array)
            .is_none_or(|d| d.is_empty())
        {
            child["depends_on"] = json!(["observe"]);
        }
        children.push(child);
    }
    children
}

async fn expand_turn_root(turn: &TurnContract, cwd: &Path) -> Option<Value> {
    let depth = bounded_env_u32("AIKO_CONTRACT_DEPTH", 0, 16);
    let max_depth = bounded_env_u32("AIKO_CONTRACT_MAX_DEPTH", DEFAULT_CONTRACT_MAX_DEPTH, 16);
    if depth >= max_depth {
        tracing::debug!(depth, max_depth, "cell expand refused: max depth");
        return None;
    }
    let max_children = bounded_env_u32(
        "AIKO_CONTRACT_MAX_CHILDREN",
        DEFAULT_CONTRACT_MAX_CHILDREN,
        16,
    ) as usize;
    let max_concurrency = bounded_env_u32(
        "AIKO_CONTRACT_MAX_CONCURRENCY",
        DEFAULT_CONTRACT_MAX_CONCURRENCY,
        16,
    );
    let skill_plan = skill_registry::plan(&turn.goal, cwd);
    let children = cell_expand_children(&turn.goal, skill_plan.children, max_children);
    if children.is_empty() {
        return None;
    }
    let request = json!({
        "root_id": turn.id,
        "plan": turn.goal,
        "action": "neuron:cell",
        "cwd": cwd,
        "agent": "aiko-native",
        "children": children,
        "selected_skills": skill_plan.selected,
        "depth": depth,
        "max_depth": max_depth,
        "max_children": max_children,
        "max_concurrency": max_concurrency,
        "execution_model": "fractal_contract_cell",
    });
    tokio::task::spawn_blocking(move || native_contract()?.expand_graph(&request))
        .await
        .ok()
        .flatten()
}

/// After a turn settles, declare one residual iterate child when the feedback
/// loop still has open work. Same primitive (contract row), pointer-shaped.
async fn close_feedback_loop(parent_id: &str, goal: &str, outcome: &str) {
    if outcome != "satisfy_failed" && outcome != "retry" {
        return;
    }
    let parent_id = parent_id.to_owned();
    let plan = format!("iterate:{parent_id} — residual after {outcome}: {goal}");
    let action = format!("posthook:iterate:{parent_id}");
    let _ = tokio::task::spawn_blocking(move || {
        native_contract()?.declare_child(&plan, &action, &parent_id)
    })
    .await;
}

pub fn contract_skill_dry_run(goal: String, cwd: PathBuf) -> Value {
    skill_registry::dry_run(&goal, &cwd)
}

pub fn contract_skill_catalog(cwd: PathBuf) -> Value {
    skill_registry::catalog(&cwd)
}

/// Pre-turn host evidence may settle *sensor* leaves only. Agent, verify, and
/// posthook feedback are the live cell path — never fabricate-green them here.
fn is_pre_turn_sensor_key(key: &str) -> bool {
    key == "observe"
        || key.ends_with("--observe")
        || key.contains("observe")
        || key.contains("sensor")
        || key.contains("prepare")
}

async fn settle_prepared_reflex_children(graph: Option<&Value>) {
    let children = graph
        .and_then(|graph| graph.get("children"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|child| child.get("held").and_then(Value::as_bool) == Some(false))
        .filter_map(|child| {
            let key = child.get("key")?.as_str()?.to_owned();
            // Never auto-close the agent / verify / feedback spine.
            if matches!(key.as_str(), "agent" | "verify" | "feedback") {
                return None;
            }
            if !is_pre_turn_sensor_key(&key) {
                return None;
            }
            Some((child.get("id")?.as_str()?.to_owned(), key))
        })
        .collect::<Vec<_>>();
    if children.is_empty() {
        return;
    }
    let _ = tokio::task::spawn_blocking(move || {
        if let Some(native) = native_contract() {
            for (id, key) in children {
                let proof = serde_json::json!({
                    "source": "aiko-native-grounding",
                    "phase": key,
                    "observed": true,
                });
                let _ = native.satisfy_with_proof(&id, &proof.to_string());
            }
        }
    })
    .await;
}

impl TurnContract {
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Record the agent verdict without exposing response content as proof.
    pub async fn satisfy(self) {
        let id = self.id.clone();
        let marked = tokio::task::spawn_blocking({
            let id = id.clone();
            move || native_contract().is_some_and(|contract| contract.satisfy_grounded(&id))
        })
        .await
        .unwrap_or(false);
        if !marked {
            tracing::debug!("failed to append native contract verdict");
        }
        // Close the feedback loop: mark prior turn card with outcome.
        let outcome = if marked {
            "satisfied"
        } else {
            "satisfy_failed"
        };
        append_turn_feedback(TurnFeedback {
            ts: chrono_ish_now(),
            goal: self.goal.clone(),
            contract_id: Some(self.id.clone()),
            proven_binary: None,
            proven_score: None,
            proven_example: None,
            open_contracts: vec![],
            outcome: Some(outcome.into()),
        });
        // Residual opens as another contract under the same parent — infinite
        // feedback is pointer fan-out, not a second orchestrator.
        close_feedback_loop(&self.id, &self.goal, outcome).await;
        if marked {
            if let Some(family) = self.learning_family {
                contract_learning::observe(&family, contract_learning::Verdict::Supported);
            }
        }
    }
}

// ── Turn feedback log (granular score/outcome loop) ─────────────────────

fn turn_feedback_path() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    Some(home.join(".aiko/context/turn-feedback.jsonl"))
}

// Legacy visual helpers remain only for migration tests. New turns reach the
// observe-desktop bundle through the generic skill registry.
fn visuals_dir() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let dir = home.join(".aiko/context/visuals");
    let _ = std::fs::create_dir_all(&dir);
    Some(dir)
}

fn append_turn_feedback(card: TurnFeedback) {
    let Some(path) = turn_feedback_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(line) = serde_json::to_string(&card) {
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = writeln!(file, "{line}");
        }
    }
}

fn load_recent_turn_feedback(limit: usize) -> Vec<TurnFeedback> {
    let Some(path) = turn_feedback_path() else {
        return Vec::new();
    };
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut cards: Vec<TurnFeedback> = raw
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    if cards.len() > limit {
        cards = cards.split_off(cards.len() - limit);
    }
    cards
}

fn format_turn_feedback_section(cards: &[TurnFeedback]) -> Option<String> {
    if cards.is_empty() {
        return None;
    }
    let mut out = String::from(
        "RECENT TURN FEEDBACK (ledger-grounded scores/outcomes — use to course-correct):\n",
    );
    for card in cards.iter().rev() {
        let cid = card.contract_id.as_deref().unwrap_or("—");
        let outcome = card.outcome.as_deref().unwrap_or("in_progress");
        let goal_short: String = card.goal.chars().take(100).collect();
        out.push_str(&format!(
            "- [{cid}] outcome={outcome} goal=\"{goal_short}\"\n"
        ));
        if let (Some(bin), Some(score)) = (&card.proven_binary, card.proven_score) {
            out.push_str(&format!("  proven={bin} score={score:.3}\n"));
        }
    }
    out.push_str(
        "Directive: prefer improving failed outcomes and reusing high-score proven routes.",
    );
    Some(out)
}

fn goal_wants_visual(goal: &str) -> bool {
    let g = goal.to_ascii_lowercase();
    [
        "website",
        "webpage",
        "landing",
        "ui",
        "visual",
        "screenshot",
        "browser",
        "page",
        "frontend",
        "css",
        "html",
        "design",
        "look",
        "render",
        "dashboard",
        "playlist",
        "preview",
        "localhost",
        "http://",
        "https://",
    ]
    .iter()
    .any(|k| g.contains(k))
}

/// Capture a feedback visual into ~/.aiko/context/visuals/latest.png.
/// Prefers CDP Page.captureScreenshot when a debug port is open; falls back
/// to macOS screencapture of the interactive display.
async fn capture_visual_feedback(goal: &str) -> Option<(PathBuf, String)> {
    if !goal_wants_visual(goal) {
        return None;
    }
    let dir = visuals_dir()?;
    let latest = dir.join("latest.png");
    let stamped = dir.join(format!("turn-{}.png", chrono_ish_now()));

    // 1) CDP screenshot if Chrome/Chromium is debug-open.
    if let Some((path, note)) = try_cdp_screenshot(&latest).await {
        let _ = std::fs::copy(&path, &stamped);
        return Some((path, note));
    }

    // 2) macOS screencapture of main display (best-effort visual loop).
    #[cfg(target_os = "macos")]
    {
        let output = tokio::time::timeout(
            Duration::from_secs(4),
            Command::new("screencapture")
                .args(["-x", "-t", "png", latest.to_str()?])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status(),
        )
        .await
        .ok()?
        .ok()?;
        if output.success() && latest.exists() {
            // Downscale for prompt budget (sips is macOS-native).
            let _ = Command::new("sips")
                .args(["-Z", "1280", latest.to_str()?])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .await;
            let _ = std::fs::copy(&latest, &stamped);
            return Some((
                latest,
                "macOS screencapture of interactive display (visual feedback loop)".into(),
            ));
        }
    }
    None
}

async fn try_cdp_screenshot(dest: &Path) -> Option<(PathBuf, String)> {
    // Probe common CDP ports used by Aiko / Chrome for Testing.
    let ports = [9222u16, 9229, 9333, 63537];
    for port in ports {
        let list_url = format!("http://127.0.0.1:{port}/json/list");
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(400))
            .build()
            .ok()?;
        let Ok(resp) = client.get(&list_url).send().await else {
            continue;
        };
        let Ok(targets) = resp.json::<Value>().await else {
            continue;
        };
        let pages = targets.as_array()?;
        let ws = pages.iter().find_map(|t| {
            let typ = t.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if typ != "page" && typ != "webview" {
                return None;
            }
            t.get("webSocketDebuggerUrl")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })?;
        // Use a tiny node-less approach via curl+websocat if available is heavy;
        // instead shell chrome-devtools style HTTP is not enough for screenshot.
        // Prefer `chromium` remote via a short python one-shot if websockets available.
        if let Some(png_b64) = cdp_capture_via_python(&ws).await {
            use base64::Engine as _;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(png_b64.trim())
                .ok()?;
            std::fs::write(dest, bytes).ok()?;
            return Some((
                dest.to_path_buf(),
                format!("CDP Page.captureScreenshot via port {port}"),
            ));
        }
    }
    None
}

async fn cdp_capture_via_python(ws_url: &str) -> Option<String> {
    // Lightweight python websocket client if present; fail soft otherwise.
    let script = format!(
        r#"
import json,sys
try:
    import websocket
except ImportError:
    sys.exit(2)
ws=websocket.create_connection({ws_url:?}, timeout=3)
ws.send(json.dumps({{"id":1,"method":"Page.enable"}}))
ws.recv()
ws.send(json.dumps({{"id":2,"method":"Page.captureScreenshot","params":{{"format":"png","fromSurface":True}}}}))
while True:
    msg=json.loads(ws.recv())
    if msg.get("id")==2:
        data=(msg.get("result") or {{}}).get("data")
        if data:
            print(data)
            sys.exit(0)
        sys.exit(1)
"#,
    );
    let output = tokio::time::timeout(
        Duration::from_secs(5),
        Command::new("python3")
            .args(["-c", &script])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    if !output.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!s.is_empty()).then_some(s)
}

fn load_visual_as_image_block(path: &Path) -> Option<acp::ContentBlock> {
    let bytes = std::fs::read(path).ok()?;
    // Cap ~1.5MB raw; larger images still go as path note only.
    if bytes.len() > 1_500_000 {
        return None;
    }
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(acp::ContentBlock::Image(acp::ImageContent::new(
        b64,
        "image/png",
    )))
}

fn context_enabled() -> bool {
    !std::env::var(CONTEXT_DISABLED_ENV)
        .ok()
        .is_some_and(|value| matches!(value.trim(), "0" | "false" | "off"))
}

fn sensitive(value: &str) -> bool {
    let value = value.to_ascii_lowercase();
    [
        ".env",
        "credential",
        "password",
        "passwd",
        "private_key",
        "private-key",
        "secret",
        "token",
        "api_key",
        "api-key",
        "auth.json",
        "keychain",
        "wallet",
        "seed",
        "cg_sk_",
        "sk-",
        "bearer ",
    ]
    .iter()
    .any(|needle| value.contains(needle))
}

fn safe_line(line: &str) -> Option<&str> {
    let line = line.trim();
    (!line.is_empty() && !sensitive(line)).then_some(line)
}

fn top_level_snapshot(cwd: &Path) -> Vec<String> {
    let mut entries = BTreeSet::new();
    let Ok(read_dir) = std::fs::read_dir(cwd) else {
        return Vec::new();
    };
    for entry in read_dir.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || sensitive(&name) {
            continue;
        }
        let suffix = if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            "/"
        } else {
            ""
        };
        entries.insert(format!("{name}{suffix}"));
        if entries.len() >= 80 {
            break;
        }
    }
    entries.into_iter().collect()
}

fn available_capabilities() -> Vec<&'static str> {
    const CANDIDATES: &[&str] = &[
        "git",
        "rg",
        "fd",
        "cargo",
        "rustc",
        "zig",
        "node",
        "npm",
        "pnpm",
        "bun",
        "python3",
        "swift",
        "xcodebuild",
        "docker",
        "kubectl",
        "gh",
        "curl",
        "jq",
        "unbrowse",
        "contract",
    ];
    let paths: Vec<PathBuf> =
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect();
    CANDIDATES
        .iter()
        .copied()
        .filter(|candidate| paths.iter().any(|path| path.join(candidate).is_file()))
        .collect()
}

fn installed_applications() -> Vec<String> {
    let mut applications = BTreeSet::new();
    let mut roots = vec![
        PathBuf::from("/Applications"),
        PathBuf::from("/System/Applications"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        roots.push(PathBuf::from(home).join("Applications"));
    }
    for root in roots {
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(name) = name.strip_suffix(".app") else {
                continue;
            };
            if !sensitive(name) {
                applications.insert(name.to_owned());
            }
        }
    }
    applications.into_iter().take(100).collect()
}

#[cfg(target_os = "macos")]
fn live_application_signals() -> (Option<String>, Vec<String>) {
    use std::ffi::{CStr, c_void};

    #[link(name = "objc")]
    unsafe extern "C" {
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn objc_msgSend();
    }
    #[link(name = "AppKit", kind = "framework")]
    unsafe extern "C" {}

    unsafe fn send_obj(receiver: *mut c_void, selector: &'static CStr) -> *mut c_void {
        let sel = unsafe { sel_registerName(selector.as_ptr()) };
        let send: unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void =
            unsafe { std::mem::transmute(objc_msgSend as *const ()) };
        unsafe { send(receiver, sel) }
    }
    unsafe fn send_index(
        receiver: *mut c_void,
        selector: &'static CStr,
        index: usize,
    ) -> *mut c_void {
        let sel = unsafe { sel_registerName(selector.as_ptr()) };
        let send: unsafe extern "C" fn(*mut c_void, *mut c_void, usize) -> *mut c_void =
            unsafe { std::mem::transmute(objc_msgSend as *const ()) };
        unsafe { send(receiver, sel, index) }
    }
    unsafe fn send_usize(receiver: *mut c_void, selector: &'static CStr) -> usize {
        let sel = unsafe { sel_registerName(selector.as_ptr()) };
        let send: unsafe extern "C" fn(*mut c_void, *mut c_void) -> usize =
            unsafe { std::mem::transmute(objc_msgSend as *const ()) };
        unsafe { send(receiver, sel) }
    }
    unsafe fn ns_string(object: *mut c_void, selector: &'static CStr) -> Option<String> {
        if object.is_null() {
            return None;
        }
        let string = unsafe { send_obj(object, selector) };
        if string.is_null() {
            return None;
        }
        let utf8 = unsafe { send_obj(string, c"UTF8String") }.cast::<c_char>();
        if utf8.is_null() {
            return None;
        }
        let value = unsafe { CStr::from_ptr(utf8) }
            .to_string_lossy()
            .into_owned();
        (!value.is_empty() && !sensitive(&value)).then_some(value)
    }

    // NSWorkspace is read directly through the Objective-C runtime. Only
    // product/bundle identifiers leave this function; titles, documents and
    // window contents are never inspected.
    unsafe {
        let pool_class = objc_getClass(c"NSAutoreleasePool".as_ptr());
        let pool = if pool_class.is_null() {
            std::ptr::null_mut()
        } else {
            send_obj(send_obj(pool_class, c"alloc"), c"init")
        };
        let class = objc_getClass(c"NSWorkspace".as_ptr());
        if class.is_null() {
            if !pool.is_null() {
                let _ = send_obj(pool, c"drain");
            }
            return (None, Vec::new());
        }
        let workspace = send_obj(class, c"sharedWorkspace");
        let front = send_obj(workspace, c"frontmostApplication");
        let frontmost = ns_string(front, c"localizedName");
        let running = send_obj(workspace, c"runningApplications");
        let count = send_usize(running, c"count");
        let mut names = BTreeSet::new();
        for index in 0..count.min(120) {
            let app = send_index(running, c"objectAtIndex:", index);
            if let Some(name) = ns_string(app, c"localizedName") {
                names.insert(name);
            }
        }
        let result = (frontmost, names.into_iter().take(40).collect());
        if !pool.is_null() {
            let _ = send_obj(pool, c"drain");
        }
        result
    }
}

#[cfg(target_os = "windows")]
fn live_application_signals() -> (Option<String>, Vec<String>) {
    use std::ffi::c_void;
    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetForegroundWindow() -> *mut c_void;
        fn GetWindowThreadProcessId(window: *mut c_void, process_id: *mut u32) -> u32;
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, process_id: u32) -> *mut c_void;
        fn QueryFullProcessImageNameW(
            process: *mut c_void,
            flags: u32,
            name: *mut u16,
            size: *mut u32,
        ) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    unsafe {
        let window = GetForegroundWindow();
        let mut process_id = 0;
        if window.is_null() || GetWindowThreadProcessId(window, &mut process_id) == 0 {
            return (None, Vec::new());
        }
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id);
        if process.is_null() {
            return (None, Vec::new());
        }
        let mut buffer = [0_u16; 1024];
        let mut length = buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length) != 0;
        let _ = CloseHandle(process);
        if !ok {
            return (None, Vec::new());
        }
        let path = String::from_utf16_lossy(&buffer[..length as usize]);
        let application = std::path::Path::new(&path)
            .file_stem()
            .and_then(|name| name.to_str())
            .filter(|name| !sensitive(name))
            .map(str::to_owned);
        (application, Vec::new())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn live_application_signals() -> (Option<String>, Vec<String>) {
    (None, Vec::new())
}

async fn discover_cdp_targets() -> Vec<String> {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(120))
        .build()
    {
        Ok(client) => client,
        Err(_) => return Vec::new(),
    };
    let mut targets = Vec::new();
    for port in [9222_u16, 9223, 9229, 9333] {
        let url = format!("http://127.0.0.1:{port}/json/version");
        let Ok(response) = client.get(url).send().await else {
            continue;
        };
        if !response.status().is_success() {
            continue;
        }
        let product = response
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|json| {
                json.get("Browser")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .filter(|value| !sensitive(value));
        // Rank useful renderer targets ahead of blank browser instances while
        // keeping page titles and URLs local. Contract needs the best endpoint,
        // not the user's browsing contents.
        let pages = client
            .get(format!("http://127.0.0.1:{port}/json/list"))
            .send()
            .await
            .ok()
            .and_then(|response| response.status().is_success().then_some(response))
            .map(|response| async move { response.json::<Vec<Value>>().await.ok() });
        let pages = match pages {
            Some(pages) => pages.await.unwrap_or_default(),
            None => Vec::new(),
        };
        let page_targets = pages
            .iter()
            .filter(|page| page.get("type").and_then(Value::as_str) == Some("page"))
            .count();
        let meaningful = pages
            .iter()
            .filter(|page| {
                if page.get("type").and_then(Value::as_str) != Some("page") {
                    return false;
                }
                let title = page
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let url = page.get("url").and_then(Value::as_str).unwrap_or_default();
                (!title.is_empty() && title != "about:blank") || !matches!(url, "" | "about:blank")
            })
            .count();
        let identity = match product {
            Some(product) => format!("{product}; pages={page_targets}; meaningful={meaningful}"),
            None => format!("pages={page_targets}; meaningful={meaningful}"),
        };
        // A dedicated Electron/application endpoint (for example 1 useful
        // renderer out of 1 page) is a much stronger signal than a general
        // browser with many blank/background tabs. Use an integer density so
        // ordering remains deterministic without retaining page contents.
        let focus_density = if page_targets == 0 {
            0
        } else {
            meaningful.saturating_mul(1_000) / page_targets
        };
        targets.push((
            focus_density,
            meaningful,
            page_targets,
            port,
            format!("127.0.0.1:{port} ({identity})"),
        ));
    }
    targets.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| b.1.cmp(&a.1))
            .then_with(|| b.2.cmp(&a.2))
            .then_with(|| a.3.cmp(&b.3))
    });
    targets
        .into_iter()
        .map(|(_, _, _, _, summary)| summary)
        .collect()
}

fn recent_trajectory_actions() -> Vec<String> {
    let Some(home) = std::env::var_os("HOME") else {
        return Vec::new();
    };
    let root = PathBuf::from(home).join(".aiko/trajectory");
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut files: Vec<_> = entries
        .flatten()
        .filter_map(|entry| {
            let modified = entry.metadata().ok()?.modified().ok()?;
            Some((modified, entry.path()))
        })
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0));
    let mut actions = BTreeSet::new();
    for (_, path) in files.into_iter().take(12) {
        let Ok(contents) = std::fs::read_to_string(path) else {
            continue;
        };
        for line in contents.lines().rev().take(200) {
            let Ok(json) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            for key in ["tool_name", "tool", "action", "capability"] {
                if let Some(value) = json.get(key).and_then(Value::as_str)
                    && value.len() <= 80
                    && !sensitive(value)
                {
                    actions.insert(value.to_owned());
                }
            }
        }
    }
    actions.into_iter().take(32).collect()
}

fn normalized_app_name(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn application_data_sources(applications: &[String]) -> Vec<String> {
    let Some(home) = std::env::var_os("HOME") else {
        return Vec::new();
    };
    let root = PathBuf::from(home).join("Library/Application Support");
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let app_keys: Vec<String> = applications
        .iter()
        .map(|name| normalized_app_name(name))
        .collect();
    let mut sources = BTreeSet::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || sensitive(&name) {
            continue;
        }
        let key = normalized_app_name(&name);
        if key.len() >= 3
            && app_keys
                .iter()
                .any(|app| app.contains(&key) || key.contains(app))
        {
            sources.insert(name);
        }
    }
    sources.into_iter().take(40).collect()
}

fn command_name(line: &str) -> Option<String> {
    let command = line.rsplit_once(';').map_or(line, |(_, command)| command);
    let command = command.split(['|', '&']).next().unwrap_or(command).trim();
    if command.is_empty() || sensitive(command) {
        return None;
    }
    let mut words = command.split_whitespace();
    let mut word = words.next()?;
    while word.contains('=') || matches!(word, "sudo" | "env" | "command" | "noglob") {
        word = words.next()?;
    }
    let name = Path::new(word).file_name()?.to_string_lossy().into_owned();
    if name.is_empty() || sensitive(&name) {
        None
    } else {
        Some(name)
    }
}

fn recent_binary_usage() -> Vec<String> {
    let Some(home) = std::env::var_os("HOME") else {
        return Vec::new();
    };
    let paths = [
        PathBuf::from(&home).join(".zsh_history"),
        PathBuf::from(&home).join(".bash_history"),
    ];
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for path in paths {
        let Ok(history) = std::fs::read_to_string(path) else {
            continue;
        };
        for line in history.lines().rev().take(2_000) {
            if let Some(name) = command_name(line) {
                *counts.entry(name).or_default() += 1;
            }
        }
    }
    let mut ranked: Vec<_> = counts.into_iter().collect();
    ranked.sort_by(|(name_a, count_a), (name_b, count_b)| {
        count_b.cmp(count_a).then_with(|| name_a.cmp(name_b))
    });
    ranked
        .into_iter()
        .take(24)
        .map(|(name, count)| format!("{name} ({count})"))
        .collect()
}

async fn command_lines(cwd: &Path, program: &str, args: &[&str], max: usize) -> Vec<String> {
    let child = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .output();
    let Ok(Ok(output)) = tokio::time::timeout(LOCAL_COMMAND_TIMEOUT, child).await else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(safe_line)
        .take(max)
        .map(ToOwned::to_owned)
        .collect()
}

fn load_profile() -> Option<String> {
    let home = std::env::var_os("HOME")?;
    let path = PathBuf::from(home).join(".aiko/context/profile.md");
    let contents = std::fs::read_to_string(path).ok()?;
    let safe: String = contents
        .lines()
        .filter_map(safe_line)
        .take(80)
        .collect::<Vec<_>>()
        .join("\n");
    (!safe.is_empty()).then_some(safe)
}

// ── Standing orders = contract ledger rows (native, not a side store) ───
//
// "whenever X always Y" is a durable contract:
//   plan:   standing: <id> | when: <triggers> | <action text>
//   action: <executable command>   // e.g. bash ~/.aiko/playlist-play.sh
//   + satisfied so `contract recommend` can rank/retrieve it
//
// Source of truth: contracts.jsonl (cwd .claude/ or ~/.contracts/).
// Optional mirror: ~/.aiko/context/standing-orders.jsonl (cache only).

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StandingOrder {
    id: String,
    /// Phrases / keywords that fire this order when present in the user goal.
    trigger: Vec<String>,
    /// What the agent must do (natural language + concrete steps).
    action: String,
    /// Shell command to run as evidence / proven action.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_goal: Option<String>,
    #[serde(default)]
    created_at: String,
    /// Ledger contract id (8-hex) when registered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    contract_id: Option<String>,
}

fn standing_orders_mirror_path() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    Some(home.join(".aiko/context/standing-orders.jsonl"))
}

fn contract_ledger_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        let local = cwd.join(".claude").join("contracts.jsonl");
        if cwd.join(".claude").is_dir() {
            paths.push(local);
        }
    }
    if let Some(home) = dirs::home_dir() {
        paths.push(home.join(".contracts").join("contracts.jsonl"));
        // Also project ledger if we're not already there
        paths.push(home.join("Unbrowse/aiko/.claude/contracts.jsonl"));
    }
    paths
}

/// Ledger plan encoding — searchable by recommend + parseable for triggers.
fn standing_plan(order: &StandingOrder) -> String {
    format!(
        "standing: {} | when: {} | {}",
        order.id,
        order.trigger.join(", "),
        order.action
    )
}

/// Proven action binary form (no `shell:` prefix — recommendable).
/// Never emit `true standing-*` no-ops — they poison recommend.
fn standing_action_cmd(order: &StandingOrder) -> String {
    let home = dirs::home_dir()
        .map(|h| h.to_string_lossy().into_owned())
        .unwrap_or_else(|| "/".into());
    if let Some(cmd) = &order.command {
        let expanded = cmd.replace("$HOME", &home).replace("~", &home);
        if expanded.ends_with(".sh") || expanded.contains('/') {
            // Scripts under .aiko use bash; open/afplay use the binary itself.
            if expanded.ends_with(".sh") {
                return format!("bash {expanded}");
            }
            return expanded;
        }
        return expanded;
    }
    // Prefer a real open of a matching asset over a no-op.
    if let Some(path) = infer_asset_command_for_triggers(&order.trigger) {
        return path;
    }
    // Last resort: echo the policy so recommend still has a non-colon action
    // with content (not a fake success).
    format!("printf '%s\\n' standing:{}", order.id)
}

/// Infer a concrete local command from standing triggers (e.g. cat → open cat.jpg).
fn infer_asset_command_for_triggers(triggers: &[String]) -> Option<String> {
    let home = dirs::home_dir()?;
    let downloads = home.join("Downloads");
    let aiko = home.join(".aiko");
    for t in triggers {
        let t = t.to_ascii_lowercase();
        if t.contains("playlist") || t == "play" || t == "song" || t == "music" {
            let script = aiko.join("playlist-play.sh");
            if script.exists() {
                return Some(format!("bash {}", script.display()));
            }
        }
        if t == "cat" || t.contains("kitten") || t == "cats" {
            // Prefer explicit cat image in Downloads or .aiko
            for name in ["cat.jpg", "cat.png", "cat.jpeg", "Cat.jpg"] {
                let p = downloads.join(name);
                if p.exists() {
                    return Some(format!("open {}", p.display()));
                }
            }
            // Fuzzy: first *cat* image
            if let Ok(rd) = std::fs::read_dir(&downloads) {
                for e in rd.flatten() {
                    let name = e.file_name().to_string_lossy().to_ascii_lowercase();
                    if name.contains("cat")
                        && (name.ends_with(".jpg")
                            || name.ends_with(".jpeg")
                            || name.ends_with(".png")
                            || name.ends_with(".webp"))
                    {
                        return Some(format!("open {}", e.path().display()));
                    }
                }
            }
        }
    }
    None
}

fn parse_standing_from_plan(plan: &str, action: &str) -> Option<StandingOrder> {
    let plan = plan.trim();
    if !plan.starts_with("standing:") {
        return None;
    }
    // standing: <id> | when: a, b | <action text>
    let rest = plan.strip_prefix("standing:")?.trim();
    let mut parts = rest.splitn(3, " | ");
    let id = parts.next()?.trim().to_string();
    if id.is_empty() {
        return None;
    }
    let when_part = parts.next().unwrap_or("").trim();
    let action_text = parts.next().unwrap_or("").trim().to_string();
    let triggers: Vec<String> = when_part
        .strip_prefix("when:")
        .unwrap_or(when_part)
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if triggers.is_empty() && action_text.is_empty() {
        return None;
    }
    let command = {
        let a = action.trim();
        if a.starts_with("bash ") {
            Some(a.trim_start_matches("bash ").trim().to_string())
        } else if a.starts_with("true standing-") {
            None
        } else if !a.is_empty() {
            Some(a.to_string())
        } else {
            None
        }
    };
    Some(StandingOrder {
        id,
        trigger: if triggers.is_empty() {
            vec!["standing".into()]
        } else {
            triggers
        },
        action: if action_text.is_empty() {
            plan.to_string()
        } else {
            action_text
        },
        command,
        source_goal: None,
        created_at: String::new(),
        contract_id: None,
    })
}

/// Load standing orders from the **contract ledger** (source of truth).
fn load_standing_orders_from_ledger() -> Vec<StandingOrder> {
    let mut by_id: BTreeMap<String, StandingOrder> = BTreeMap::new();
    let mut satisfied: BTreeSet<String> = BTreeSet::new();
    let mut declared: BTreeMap<String, (String, String)> = BTreeMap::new(); // id -> (plan, action)

    for path in contract_ledger_paths() {
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        for line in raw.lines() {
            let line = line.trim();
            if line.is_empty() || !line.starts_with('{') {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            let event = v.get("event").and_then(|e| e.as_str()).unwrap_or("");
            let id = v.get("id").and_then(|e| e.as_str()).unwrap_or("");
            if id.is_empty() {
                continue;
            }
            match event {
                "declared" => {
                    let plan = v.get("plan").and_then(|p| p.as_str()).unwrap_or("");
                    if !plan.starts_with("standing:") {
                        continue;
                    }
                    let action = v.get("action").and_then(|a| a.as_str()).unwrap_or("");
                    declared.insert(id.to_string(), (plan.to_string(), action.to_string()));
                }
                "satisfied" => {
                    satisfied.insert(id.to_string());
                }
                _ => {}
            }
        }
    }

    for (cid, (plan, action)) in declared {
        if let Some(mut order) = parse_standing_from_plan(&plan, &action) {
            order.contract_id = Some(cid);
            // Poison / empty action → recover a real local command from triggers.
            if order.command.is_none()
                || order
                    .command
                    .as_deref()
                    .is_some_and(is_poison_standing_action)
            {
                order.command = infer_asset_command_for_triggers(&order.trigger);
            }
            // Prefer satisfied rows; still load unsatisfied as pending standing claims.
            by_id.insert(order.id.clone(), order);
        }
    }
    let _ = satisfied; // used for future filtering if needed
    by_id.into_values().collect()
}

/// Mirror cache for fast agents / UI — ledger remains authoritative.
fn mirror_standing_orders(orders: &[StandingOrder]) {
    let Some(path) = standing_orders_mirror_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut body = String::new();
    for o in orders {
        if let Ok(line) = serde_json::to_string(o) {
            body.push_str(&line);
            body.push('\n');
        }
    }
    let _ = std::fs::write(path, body);
}

fn is_poison_standing_action(action: &str) -> bool {
    let a = action.trim();
    a.starts_with("true standing") || a == "true" || a.starts_with("printf '")
}

/// Register standing order as declared+satisfied ledger rows (recommendable).
/// Re-appends when the prior row was a poison no-op (`true standing-*`) so
/// `contract recommend` learns a real command.
fn register_standing_on_ledger(order: &StandingOrder) -> Option<String> {
    let plan = standing_plan(order);
    let action = standing_action_cmd(order);
    // Stable 8-hex id from order.id so re-registering is idempotent-ish.
    let contract_id = {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut h = DefaultHasher::new();
        order.id.hash(&mut h);
        format!("{:016x}", h.finish())[..8].to_string()
    };

    // Skip only when a non-poison registration already exists for this id
    // with a usable command and decent triggers (not picture-only cat bug).
    for existing in load_standing_orders_from_ledger() {
        if existing.id != order.id {
            continue;
        }
        let cmd_ok = existing
            .command
            .as_ref()
            .is_some_and(|c| !is_poison_standing_action(c) && !c.starts_with("true "));
        let triggers_ok = !(existing.trigger.len() == 1 && existing.trigger[0] == "picture");
        if cmd_ok && triggers_ok && !is_poison_standing_action(&action) {
            return existing.contract_id.or(Some(contract_id));
        }
        // Fall through to re-append a fixed declared+satisfied pair.
        break;
    }

    // Refuse to write new poison — force infer / printf policy instead.
    let action = if is_poison_standing_action(&action) {
        standing_action_cmd(&StandingOrder {
            command: infer_asset_command_for_triggers(&order.trigger),
            ..order.clone()
        })
    } else {
        action
    };

    let ts = chrono_ish_now();
    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| ".".into());
    let declared = json!({
        "event": "declared",
        "id": contract_id,
        "plan": plan,
        "action": action,
        "pointer_type": "cli",
        "layer": 2,
        "cwd": cwd,
        "parent_id": null,
        "synapses": [],
        "ts": ts,
        "agent": "aiko-standing",
        "availability": "runtime_loaded",
        "permission": "read",
    });
    let satisfied = json!({
        "event": "satisfied",
        "id": contract_id,
        "wave": 0,
        "ts": ts,
        "proof": format!("standing:{}", order.id),
        "agent": "aiko-standing",
    });

    for path in contract_ledger_paths() {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            let _ = writeln!(file, "{}", declared);
            let _ = writeln!(file, "{}", satisfied);
        }
    }
    Some(contract_id)
}

fn load_standing_orders() -> Vec<StandingOrder> {
    let mut orders = load_standing_orders_from_ledger();
    // Migrate legacy JSONL mirror into ledger once.
    if let Some(path) = standing_orders_mirror_path() {
        if let Ok(raw) = std::fs::read_to_string(&path) {
            for line in raw.lines() {
                if let Ok(order) = serde_json::from_str::<StandingOrder>(line) {
                    if !orders.iter().any(|o| o.id == order.id) {
                        if let Some(cid) = register_standing_on_ledger(&order) {
                            let mut o = order;
                            o.contract_id = Some(cid);
                            orders.push(o);
                        }
                    }
                }
            }
        }
    }
    mirror_standing_orders(&orders);
    orders
}

fn append_standing_order(order: &StandingOrder) -> bool {
    let mut order = order.clone();
    let cid = register_standing_on_ledger(&order);
    order.contract_id = cid;
    // Refresh mirror from ledger
    let all = load_standing_orders_from_ledger();
    let mut merged = all;
    if !merged.iter().any(|o| o.id == order.id) {
        merged.push(order.clone());
    }
    mirror_standing_orders(&merged);
    order.contract_id.is_some() || !merged.is_empty()
}

fn standing_order_matches(order: &StandingOrder, goal_lc: &str) -> bool {
    order.trigger.iter().any(|t| {
        let t = t.trim().to_ascii_lowercase();
        !t.is_empty() && goal_lc.contains(&t)
    })
}

fn matching_standing_orders(goal: &str) -> Vec<StandingOrder> {
    let goal_lc = goal.to_ascii_lowercase();
    let mut orders: Vec<StandingOrder> = load_standing_orders()
        .into_iter()
        .filter(|o| standing_order_matches(o, &goal_lc))
        .map(|mut o| {
            // Poison / missing command → infer real local action so enforce works.
            if o.command.is_none()
                || o.command
                    .as_deref()
                    .is_some_and(|c| is_poison_standing_action(c) || c.starts_with("true "))
            {
                o.command = infer_asset_command_for_triggers(&o.trigger).or_else(|| {
                    // Triggers may be weak (e.g. only "picture") — also use goal tokens.
                    let tokens: Vec<String> = goal_lc
                        .split(|c: char| !c.is_alphanumeric())
                        .filter(|t| t.len() >= 3)
                        .map(|s| s.to_string())
                        .collect();
                    infer_asset_command_for_triggers(&tokens)
                });
            }
            o
        })
        .collect();
    // Prefer canonical ids (so-cat-picture, so-playlist-*) over hashed duplicates,
    // then drop orders that resolve to the same expanded command.
    orders.sort_by(|a, b| {
        let canon = |id: &str| {
            id.starts_with("so-")
                && !id
                    .trim_start_matches("so-")
                    .chars()
                    .all(|c| c.is_ascii_hexdigit())
        };
        canon(b.id.as_str())
            .cmp(&canon(a.id.as_str()))
            .then_with(|| a.id.cmp(&b.id))
    });
    let mut seen_cmds = BTreeSet::new();
    orders.retain(|o| {
        let key = o
            .command
            .as_ref()
            .map(|c| expand_home(c))
            .unwrap_or_else(|| format!("policy:{}", o.id));
        seen_cmds.insert(key)
    });
    orders
}

/// Result of harness-enforced standing order execution (not model-dependent).
#[derive(Debug, Clone, Serialize)]
struct StandingExecResult {
    order_id: String,
    command: String,
    exit: i32,
    stdout: String,
    ok: bool,
    skipped: Option<String>,
}

fn expand_home(cmd: &str) -> String {
    let home = dirs::home_dir()
        .map(|h| h.to_string_lossy().into_owned())
        .unwrap_or_else(|| "/".into());
    cmd.replace("$HOME", &home).replace("~", &home)
}

/// Allowlist auto-exec: ~/.aiko scripts, open/afplay of home Downloads assets.
fn is_safe_standing_command(cmd: &str) -> bool {
    let expanded = expand_home(cmd);
    let trimmed = expanded.trim();
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    let home_s = home.to_string_lossy().to_string();
    // `open ~/Downloads/cat.jpg` or `afplay ...`
    if let Some(rest) = trimmed.strip_prefix("open ") {
        let p = rest.trim().trim_matches('"').trim_matches('\'');
        return p.starts_with(&home_s) || p.starts_with(&format!("{home_s}/"));
    }
    if let Some(rest) = trimmed.strip_prefix("afplay ") {
        let p = rest.trim().trim_matches('"').trim_matches('\'');
        return p.starts_with(&home_s);
    }
    let path = trimmed
        .trim_start_matches("bash ")
        .trim_start_matches("-lc ")
        .trim()
        .trim_matches('"')
        .trim_matches('\'');
    let aiko = home.join(".aiko");
    if let Ok(canon) = PathBuf::from(path).canonicalize() {
        if let Ok(aiko_c) = aiko.canonicalize() {
            return canon.starts_with(&aiko_c);
        }
    }
    let s = path;
    s.starts_with(&aiko.to_string_lossy().to_string()) || s.contains("/.aiko/")
}

/// Run a standing order's proven command in the harness (enforce, don't hope).
async fn run_standing_command(order: &StandingOrder) -> StandingExecResult {
    // Fill missing command from triggers if possible.
    let mut order = order.clone();
    if order.command.is_none() {
        order.command = infer_asset_command_for_triggers(&order.trigger);
    }
    let Some(raw) = order.command.as_ref() else {
        return StandingExecResult {
            order_id: order.id.clone(),
            command: String::new(),
            exit: -1,
            stdout: String::new(),
            ok: false,
            skipped: Some("no command on standing order".into()),
        };
    };
    let expanded = expand_home(raw);
    if !is_safe_standing_command(&expanded) {
        return StandingExecResult {
            order_id: order.id.clone(),
            command: expanded,
            exit: -1,
            stdout: String::new(),
            ok: false,
            skipped: Some("command outside allowlist (~/.aiko scripts or open home assets)".into()),
        };
    }
    let (program, args): (String, Vec<String>) = if let Some(rest) = expanded.strip_prefix("open ")
    {
        ("open".into(), vec![rest.trim().to_string()])
    } else if let Some(rest) = expanded.strip_prefix("afplay ") {
        ("afplay".into(), vec![rest.trim().to_string()])
    } else if let Some(rest) = expanded.strip_prefix("bash ") {
        ("bash".into(), vec![rest.trim().to_string()])
    } else {
        ("bash".into(), vec![expanded.clone()])
    };
    let output = tokio::time::timeout(
        Duration::from_secs(20),
        Command::new(&program)
            .args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output(),
    )
    .await;
    match output {
        Ok(Ok(out)) => {
            let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
            let err = String::from_utf8_lossy(&out.stderr);
            if !err.trim().is_empty() {
                if !text.is_empty() {
                    text.push('\n');
                }
                text.push_str(err.trim());
            }
            // Cap evidence size in prompt.
            if text.len() > 800 {
                text.truncate(800);
                text.push_str("…");
            }
            let code = out.status.code().unwrap_or(-1);
            StandingExecResult {
                order_id: order.id.clone(),
                command: format!("{program} {}", args.join(" ")),
                exit: code,
                stdout: text,
                ok: out.status.success(),
                skipped: None,
            }
        }
        Ok(Err(e)) => StandingExecResult {
            order_id: order.id.clone(),
            command: format!("{program} {}", args.join(" ")),
            exit: -1,
            stdout: e.to_string(),
            ok: false,
            skipped: None,
        },
        Err(_) => StandingExecResult {
            order_id: order.id.clone(),
            command: format!("{program} {}", args.join(" ")),
            exit: -1,
            stdout: "timed out after 20s".into(),
            ok: false,
            skipped: None,
        },
    }
}

async fn enforce_standing_orders(orders: &[StandingOrder]) -> Vec<StandingExecResult> {
    let mut results = Vec::with_capacity(orders.len());
    for order in orders {
        // Infer missing command one more time (matching path should have filled it).
        let mut order = order.clone();
        if order.command.is_none() {
            order.command = infer_asset_command_for_triggers(&order.trigger);
        }
        if order.command.is_none() {
            results.push(StandingExecResult {
                order_id: order.id.clone(),
                command: String::new(),
                exit: 0,
                stdout: String::new(),
                ok: true,
                skipped: Some(
                    "policy-only (no executable); agent must still obey action text".into(),
                ),
            });
            continue;
        }
        results.push(run_standing_command(&order).await);
    }
    results
}

async fn enforce_ranked_reflex(rankings: &Value, proven: Option<&Value>) -> Option<Value> {
    let proven = proven?;
    let binary = proven.get("binary")?.as_str()?;
    let command = proven.get("example")?.as_str()?;
    let candidate = rankings
        .get("candidates")?
        .as_array()?
        .iter()
        .find(|candidate| candidate.get("binary").and_then(Value::as_str) == Some(binary))?;
    let decision = decide_reflex(
        binary,
        candidate
            .get("successes")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        candidate
            .get("failures")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        candidate
            .get("confidence")
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
        "local_reversible",
        false,
        true,
        false,
        0.0,
    );
    let verdict = decision
        .get("decision")
        .and_then(Value::as_str)
        .unwrap_or("hold");
    if verdict != "fire" {
        return Some(
            json!({ "capability": binary, "command": command, "policy": decision, "executed": false }),
        );
    }
    // The substrate ranks and gates muscle memory, but concrete execution is
    // owned by the selected contract-native skill. This avoids maintaining a
    // second domain-specific command allowlist in core.
    Some(json!({
        "capability": binary,
        "command": command,
        "policy": decision,
        "executed": false,
        "delegated_to_contract_skill": true,
    }))
}

/// Detect "whenever X always Y" / "every time X do Y" and persist as ledger standing order.
fn maybe_learn_standing_order(goal: &str) -> Option<StandingOrder> {
    let lower = goal.to_ascii_lowercase();
    let is_standing = lower.contains("whenever")
        || lower.contains("every time")
        || lower.contains("always when")
        || lower.contains("from now on")
        || (lower.contains("always")
            && (lower.contains("when i") || lower.contains("when you") || lower.contains("i say")))
        || lower.contains("i should see")
        || lower.contains("you should always");
    if !is_standing {
        return None;
    }

    let playlistish = lower.contains("playlist");
    let play_song = lower.contains("play a song")
        || lower.contains("play song")
        || lower.contains("play music")
        || lower.contains("play a random");
    let catish = lower.contains("cat")
        && (lower.contains("picture")
            || lower.contains("image")
            || lower.contains("photo")
            || lower.contains("see"));

    let (triggers, action, command, id) = if playlistish && play_song {
        (
            vec![
                "playlist".into(),
                "show me my playlist".into(),
                "show my playlist".into(),
                "show playlist".into(),
            ],
            "When the user asks for their playlist: (1) show the playlist UI, AND \
             (2) ALWAYS start playing a song via ~/.aiko/playlist-play.sh."
                .to_string(),
            Some("$HOME/.aiko/playlist-play.sh".into()),
            "so-playlist-always-play".into(),
        )
    } else if catish {
        (
            vec!["cat".into(), "cats".into(), "kitten".into()],
            "When the user says cat/cats/kitten: open a local cat picture every time.".to_string(),
            infer_asset_command_for_triggers(&["cat".into()])
                .or_else(|| Some("open $HOME/Downloads/cat.jpg".into())),
            "so-cat-picture".into(),
        )
    } else {
        // Keep short content words (cat, dog) — was `> 3` and dropped them.
        let stop = [
            "whenever", "always", "every", "time", "from", "should", "that", "this", "with",
            "your", "when", "then", "must", "will", "into", "about", "have", "say", "said", "see",
            "show", "make", "want", "need", "just", "like", "picture", "image", "photo",
        ];
        let mut triggers: Vec<String> = lower
            .split(|c: char| !c.is_alphanumeric())
            .filter(|t| t.len() >= 3)
            .filter(|t| !stop.contains(t))
            .take(8)
            .map(|s| s.to_string())
            .collect();
        if let Some(idx) = lower.find("i say ") {
            let rest = &lower[idx + 6..];
            if let Some(word) = rest
                .split(|c: char| !c.is_alphanumeric())
                .find(|t| t.len() >= 2)
            {
                if !triggers.iter().any(|t| t == word) {
                    triggers.insert(0, word.to_string());
                }
            }
        }
        if triggers.is_empty() {
            return None;
        }
        let id = format!("so-{}", sha2_short(goal));
        let cmd = infer_asset_command_for_triggers(&triggers);
        (
            triggers,
            format!("Standing user rule (follow on every matching turn): {goal}"),
            cmd,
            id,
        )
    };

    let order = StandingOrder {
        id,
        trigger: triggers,
        action,
        command,
        source_goal: Some(goal.to_string()),
        created_at: chrono_ish_now(),
        contract_id: None,
    };
    if append_standing_order(&order) {
        load_standing_orders()
            .into_iter()
            .find(|o| o.id == order.id)
            .or(Some(order))
    } else {
        None
    }
}

/// Scan ledger for prior user declares that match this goal (true recall).
fn recall_matching_declarations(goal: &str) -> Vec<String> {
    let goal_lc = goal.to_ascii_lowercase();
    let tokens: Vec<String> = goal_lc
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.len() >= 3)
        .filter(|t| {
            !matches!(
                *t,
                "the" | "and" | "for" | "with" | "from" | "that" | "this" | "show" | "me" | "my"
            )
        })
        .map(|s| s.to_string())
        .collect();
    if tokens.is_empty() {
        return Vec::new();
    }
    let mut hits: Vec<(usize, String, String)> = Vec::new();
    let mut seen_plans = BTreeSet::new();
    for path in contract_ledger_paths() {
        let Ok(raw) = std::fs::read_to_string(path) else {
            continue;
        };
        for line in raw.lines().rev().take(5000) {
            let line = line.trim();
            if !line.starts_with('{') {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            if v.get("event").and_then(|e| e.as_str()) != Some("declared") {
                continue;
            }
            let plan = v.get("plan").and_then(|p| p.as_str()).unwrap_or("");
            let action = v.get("action").and_then(|a| a.as_str()).unwrap_or("");
            let id = v.get("id").and_then(|i| i.as_str()).unwrap_or("");
            if plan.len() > 400 || plan.contains("tool:bash") || plan.contains("```") {
                continue;
            }
            if action.starts_with("tool:") {
                continue;
            }
            let plan_lc = plan.to_ascii_lowercase();
            let score = tokens
                .iter()
                .filter(|t| plan_lc.contains(t.as_str()))
                .count();
            if score == 0 {
                continue;
            }
            let key: String = plan_lc.chars().take(120).collect();
            if !seen_plans.insert(key) {
                continue;
            }
            hits.push((score, id.to_string(), plan.to_string()));
            if hits.len() > 50 {
                break;
            }
        }
    }
    hits.sort_by(|a, b| b.0.cmp(&a.0));
    hits.into_iter()
        .take(8)
        .map(|(score, id, plan)| {
            format!(
                "[{id}] match={score} plan=\"{}\"",
                plan.chars().take(160).collect::<String>()
            )
        })
        .collect()
}

fn sha2_short(s: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    s.hash(&mut h);
    let hex = format!("{:016x}", h.finish());
    hex[..10].to_string()
}

fn chrono_ish_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

/// Seed known standing orders onto the ledger; upgrade poison rows.
fn ensure_default_standing_orders() {
    let existing = load_standing_orders_from_ledger();

    // Playlist: always-play on "show me my playlist".
    if !existing.iter().any(|o| {
        o.id == "so-playlist-always-play"
            && o.command
                .as_ref()
                .is_some_and(|c| !is_poison_standing_action(c))
    }) {
        let order = StandingOrder {
            id: "so-playlist-always-play".into(),
            trigger: vec![
                "playlist".into(),
                "show me my playlist".into(),
                "show my playlist".into(),
                "show playlist".into(),
            ],
            action: "When the user asks for their playlist: (1) show the playlist UI \
                     (json-render / existing aiko:ui surface), AND (2) ALWAYS start \
                     playing a song by running `~/.aiko/playlist-play.sh`. Never show \
                     the playlist without playing a track."
                .into(),
            command: Some("$HOME/.aiko/playlist-play.sh".into()),
            source_goal: Some(
                "whenever i say show me my playlist, you should always play a song".into(),
            ),
            created_at: chrono_ish_now(),
            contract_id: None,
        };
        let _ = append_standing_order(&order);
    }

    // Cat picture: whenever user says cat → open local cat image.
    // Also upgrades the broken so-559c86f502 (trigger=picture, true standing-*).
    let cat_ok = existing.iter().any(|o| {
        (o.id == "so-cat-picture" || o.trigger.iter().any(|t| t == "cat"))
            && o.command.as_ref().is_some_and(|c| {
                !is_poison_standing_action(c) && (c.contains("open") || c.contains("cat"))
            })
    });
    if !cat_ok {
        let cmd = infer_asset_command_for_triggers(&["cat".into()])
            .or_else(|| Some("open $HOME/Downloads/cat.jpg".into()));
        let order = StandingOrder {
            id: "so-cat-picture".into(),
            trigger: vec!["cat".into(), "cats".into(), "kitten".into()],
            action: "When the user says cat/cats/kitten: open a local cat picture every time."
                .into(),
            command: cmd,
            source_goal: Some("whenever i say cat i should see a picture of a cat".into()),
            created_at: chrono_ish_now(),
            contract_id: None,
        };
        let _ = append_standing_order(&order);
    }

    // Re-write mirror after any upgrades.
    let all = load_standing_orders_from_ledger();
    mirror_standing_orders(&all);
}

async fn contract_recommendation(
    goal: &str,
    availability: serde_json::Value,
) -> Option<serde_json::Value> {
    let goal = goal.to_owned();
    let availability = availability.to_string();
    tokio::task::spawn_blocking(move || {
        native_contract()?.recommend_capabilities(&goal, &availability)
    })
    .await
    .ok()
    .flatten()
}

fn registered_capability_sources() -> &'static Mutex<BTreeSet<String>> {
    static SOURCES: OnceLock<Mutex<BTreeSet<String>>> = OnceLock::new();
    SOURCES.get_or_init(|| Mutex::new(BTreeSet::new()))
}

fn registered_capability_descriptors()
-> &'static Mutex<BTreeMap<String, crate::capability_catalog::CapabilityDescriptor>> {
    static DESCRIPTORS: OnceLock<
        Mutex<BTreeMap<String, crate::capability_catalog::CapabilityDescriptor>>,
    > = OnceLock::new();
    DESCRIPTORS.get_or_init(|| Mutex::new(BTreeMap::new()))
}

#[derive(Clone)]
struct ActiveCapabilityPlan {
    context: String,
    plan: Value,
    root_id: Option<String>,
}

fn active_capability_plans() -> &'static Mutex<HashMap<String, ActiveCapabilityPlan>> {
    static PLANS: OnceLock<Mutex<HashMap<String, ActiveCapabilityPlan>>> = OnceLock::new();
    PLANS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn set_active_capability_plan(
    session_id: &str,
    context: String,
    plan: Option<Value>,
    root_id: Option<String>,
) {
    let Ok(mut plans) = active_capability_plans().lock() else {
        return;
    };
    // The task context is useful muscle-memory supervision even when the
    // catalog cannot recommend a known contract yet. A null plan simply means
    // that this invocation can train a new context -> binary association.
    plans.insert(
        session_id.to_owned(),
        ActiveCapabilityPlan {
            context,
            plan: plan.unwrap_or(Value::Null),
            root_id,
        },
    );
}

fn descriptor_matches_tool(
    descriptor: &crate::capability_catalog::CapabilityDescriptor,
    tool_name: &str,
    raw_arguments: Option<&str>,
) -> bool {
    if let Some(server) = descriptor.provider.strip_prefix("mcp:") {
        return tool_name.eq_ignore_ascii_case(&format!("{server}__{}", descriptor.tool));
    }
    if !tool_name.eq_ignore_ascii_case(&descriptor.tool) {
        return false;
    }
    if matches!(
        descriptor.provider.as_str(),
        "skill" | "unbrowse" | "binary"
    ) {
        return raw_arguments.is_some_and(|arguments| arguments.contains(&descriptor.action));
    }
    true
}

/// Describe a tool input without retaining values. This is the state seen by
/// the transition learner, so credentials and user data never become weights.
fn structural_json(value: &Value, depth: usize) -> Value {
    if depth >= 3 {
        return Value::String("…".into());
    }
    match value {
        Value::Null => Value::String("null".into()),
        Value::Bool(_) => Value::String("bool".into()),
        Value::Number(_) => Value::String("number".into()),
        Value::String(_) => Value::String("string".into()),
        Value::Array(items) => json!({
            "array": items.len(),
            "items": items.first().map(|item| structural_json(item, depth + 1))
        }),
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .take(32)
                .map(|(key, value)| (key.clone(), structural_json(value, depth + 1)))
                .collect(),
        ),
    }
}

fn muscle_before_state(tool_name: &str, raw_arguments: Option<&str>) -> String {
    let input = raw_arguments
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .map(|value| structural_json(&value, 0))
        .unwrap_or_else(|| Value::String("unparsed".into()));
    json!({ "tool": tool_name, "input": input }).to_string()
}

fn muscle_after_state(
    success: bool,
    duration_ms: u64,
    result_shape: crate::capability_catalog::ResultShape,
    error_class: Option<crate::capability_catalog::ObservationError>,
) -> String {
    let duration_bucket = match duration_ms {
        0..=99 => "<100ms",
        100..=999 => "<1s",
        1_000..=9_999 => "<10s",
        _ => ">=10s",
    };
    json!({
        "success": success,
        "duration": duration_bucket,
        "result": result_shape,
        "error": error_class,
    })
    .to_string()
}

/// Materialize a tool invocation beneath the active turn before dispatch. Only
/// structural argument information is retained; values never enter the plan.
#[derive(Debug, Clone)]
pub struct ActiveToolContract {
    root_id: String,
    execution_id: String,
}

/// Runtime authorization produced by the Contract membrane.
///
/// Absence of the native substrate is not represented as `None`: read-only
/// work degrades explicitly while consequential work is held before dispatch.
#[derive(Debug, Clone)]
pub enum ToolContractBinding {
    Authorized(ActiveToolContract),
    UngovernedReadOnly { reason: String },
    Hold { reason: String },
}

impl ToolContractBinding {
    pub fn may_execute(&self) -> bool {
        !matches!(self, Self::Hold { .. })
    }

    pub fn hold_reason(&self) -> Option<&str> {
        match self {
            Self::Hold { reason } => Some(reason),
            _ => None,
        }
    }
}

/// Honest separation between authorization, execution, acknowledgement, and
/// goal progress. A successful syscall/tool return never manufactures progress.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ContractExecutionReceipt {
    pub authorization: &'static str,
    pub executed: bool,
    pub environment_acknowledged: bool,
    pub progress: Option<bool>,
}

pub fn execution_receipt(
    binding: &ToolContractBinding,
    executed: bool,
    environment_acknowledged: bool,
) -> ContractExecutionReceipt {
    ContractExecutionReceipt {
        authorization: match binding {
            ToolContractBinding::Authorized(_) => "contract_authorized",
            ToolContractBinding::UngovernedReadOnly { .. } => "read_only_degraded",
            ToolContractBinding::Hold { .. } => "hold",
        },
        executed,
        environment_acknowledged,
        progress: None,
    }
}

fn binding_or_policy(
    binding: Option<ActiveToolContract>,
    read_only: bool,
    reason: impl Into<String>,
) -> ToolContractBinding {
    if let Some(binding) = binding {
        ToolContractBinding::Authorized(binding)
    } else if read_only {
        ToolContractBinding::UngovernedReadOnly {
            reason: reason.into(),
        }
    } else {
        ToolContractBinding::Hold {
            reason: reason.into(),
        }
    }
}

pub fn bind_active_tool_contract(
    session_id: &str,
    tool_name: &str,
    raw_arguments: Option<&str>,
    read_only: bool,
) -> ToolContractBinding {
    let Some(root_id) = active_capability_plans()
        .lock()
        .ok()
        .and_then(|plans| plans.get(session_id).cloned())
        .and_then(|plan| plan.root_id)
    else {
        return binding_or_policy(None, read_only, "no active Contract root");
    };
    let before = muscle_before_state(tool_name, raw_arguments);
    let plan = format!("Invoke {tool_name} with structural input {before}");
    let Some(native) = native_contract() else {
        return binding_or_policy(None, read_only, "Contract substrate unavailable");
    };
    let Some(tool_root) = native.declare_child(&plan, &format!("tool:{tool_name}"), &root_id)
    else {
        return binding_or_policy(None, read_only, "Contract tool declaration failed");
    };
    let Some(graph) = native.expand_graph(&json!({
        "root_id": tool_root,
        "plan": plan,
        "action": format!("tool:{tool_name}"),
        "children": [
            {
                "key": "prerequisite",
                "plan": format!("Validate structural arguments and availability for {tool_name}"),
                "action": "tool_prerequisite"
            },
            {
                "key": "authorization",
                "plan": format!("Record the approved native gate decision for {tool_name}"),
                "action": "tool_authorization"
            },
            {
                "key": "execution",
                "plan": format!("Execute {tool_name} and ground its observed outcome"),
                "action": format!("tool:{tool_name}"),
                "depends_on": ["prerequisite", "authorization"]
            }
        ]
    })) else {
        return binding_or_policy(None, read_only, "Contract graph expansion failed");
    };
    let Some(children) = graph.get("children").and_then(Value::as_array) else {
        return binding_or_policy(None, read_only, "Contract graph returned no children");
    };
    let Some(prerequisite) = children
        .iter()
        .find(|child| child.get("key").and_then(Value::as_str) == Some("prerequisite"))
        .and_then(|child| child.get("id"))
        .and_then(Value::as_str)
    else {
        return binding_or_policy(None, read_only, "Contract prerequisite cell missing");
    };
    let Some(authorization) = children
        .iter()
        .find(|child| child.get("key").and_then(Value::as_str) == Some("authorization"))
        .and_then(|child| child.get("id"))
        .and_then(Value::as_str)
    else {
        return binding_or_policy(None, read_only, "Contract authorization cell missing");
    };
    let Some(execution_id) = children
        .iter()
        .find(|child| child.get("key").and_then(Value::as_str) == Some("execution"))
        .and_then(|child| child.get("id"))
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        return binding_or_policy(None, read_only, "Contract execution cell missing");
    };
    if !native.satisfy(prerequisite) || !native.satisfy(authorization) {
        return binding_or_policy(
            None,
            read_only,
            "Contract prerequisite authorization failed",
        );
    }
    binding_or_policy(
        Some(ActiveToolContract {
            root_id: tool_root,
            execution_id,
        }),
        read_only,
        "unreachable",
    )
}

pub fn settle_active_tool_contract(binding: &ToolContractBinding, success: bool) {
    let receipt = execution_receipt(binding, binding.may_execute(), success);
    xai_grok_telemetry::unified_log::info(
        "contract.execution.receipt",
        None,
        serde_json::to_value(&receipt).ok(),
    );
    let ToolContractBinding::Authorized(contract) = binding else {
        return;
    };
    let Some(native) = native_contract() else {
        return;
    };
    if success {
        if native.satisfy(&contract.execution_id) {
            let _ = native.satisfy_grounded(&contract.root_id);
        }
    } else {
        let _ = native.fail(&contract.execution_id, "observed tool failure");
        let _ = native.fail(&contract.root_id, "execution child failed");
    }
}

pub fn record_active_capability_observation(
    session_id: &str,
    tool_name: &str,
    raw_arguments: Option<&str>,
    success: bool,
    duration_ms: u64,
    permission_result: crate::capability_catalog::PermissionResult,
    error_class: Option<crate::capability_catalog::ObservationError>,
    result_shape: crate::capability_catalog::ResultShape,
) {
    let active = active_capability_plans()
        .lock()
        .ok()
        .and_then(|plans| plans.get(session_id).cloned());
    let Some(active) = active else { return };
    let before = muscle_before_state(tool_name, raw_arguments);
    let after = muscle_after_state(success, duration_ms, result_shape, error_class);
    let candidates = active
        .plan
        .get("candidates")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let selected = registered_capability_descriptors()
        .lock()
        .ok()
        .and_then(|descriptors| {
            candidates.iter().find_map(|candidate| {
                let id = candidate.get("capability_id")?.as_str()?;
                let version = candidate.get("capability_version")?.as_str()?;
                let descriptor = descriptors.get(id)?;
                (descriptor.capability_version == version
                    && descriptor_matches_tool(descriptor, tool_name, raw_arguments))
                .then(|| (id.to_owned(), version.to_owned()))
            })
        });
    let observation = selected.map(|(capability_id, capability_version)| {
        crate::capability_catalog::CapabilityObservation {
            schema_version: 1,
            capability_id,
            capability_version,
            success,
            duration_ms: duration_ms.min(86_400_000),
            permission_result,
            error_class,
            result_shape,
            observed_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        }
    });
    let context = active.context;
    let binary = tool_name.to_owned();
    tokio::task::spawn_blocking(move || {
        let native = native_contract();
        let learned = native.is_some_and(|native| {
            native.observe_muscle(
                &context,
                &binary,
                &before,
                &after,
                if success { 1.0 } else { -1.0 },
            )
        });
        if !learned {
            tracing::debug!(tool = %binary, "Contract muscle observation was not recorded");
        }
        let Some(observation) = observation else {
            return;
        };
        let recorded = native.and_then(|native| native.record_observation(&context, &observation));
        if recorded.is_none() {
            tracing::warn!(
                capability_id = %observation.capability_id,
                "Contract rejected or could not persist sanitized FECH observation"
            );
        } else if let Err(error) =
            crate::collective_host::publish_collective_observation(&observation)
        {
            tracing::warn!(
                capability_id = %observation.capability_id,
                %error,
                "Collective aggregate attestation was not published"
            );
        }
    });
}

/// Refresh all four live FECH inventories and ask Contract for a versioned,
/// availability-qualified plan. Snapshot replacement and ranking happen on a
/// blocking worker because the native ABI is synchronous and internally
/// serialized.
pub async fn refresh_capabilities_and_recommend(
    tools: Vec<xai_grok_tools::types::definition::ToolDefinition>,
    cwd: PathBuf,
    goal: String,
) -> Option<Value> {
    let mut snapshots = crate::capability_catalog::normalize_tool_definitions(&tools);
    snapshots.push(crate::capability_catalog::discover_skill_snapshot(&cwd));
    let command_tool = tools.iter().find_map(|definition| {
        let name = definition.function.name.as_str();
        matches!(
            name.to_ascii_lowercase().as_str(),
            "bash" | "shell" | "run_terminal_cmd" | "execute_command"
        )
        .then_some(name)
    });
    snapshots.push(crate::capability_catalog::discover_binary_snapshot(
        command_tool,
    ));
    snapshots.push(crate::capability_catalog::discover_unbrowse_snapshot(
        command_tool,
    ));
    tokio::task::spawn_blocking(move || {
        let native = native_contract()?;
        let current: BTreeSet<String> = snapshots
            .iter()
            .map(|snapshot| snapshot.source.clone())
            .collect();
        let previous = registered_capability_sources().lock().ok()?.clone();

        // A provider disappearing is a source replacement with an empty
        // snapshot. Contract retains historical evidence but cannot route it.
        for source in previous.difference(&current) {
            native.register_capabilities(
                source,
                &Vec::<crate::capability_catalog::CapabilityDescriptor>::new(),
            )?;
        }
        let mut availability = Vec::new();
        for snapshot in &snapshots {
            native.register_capabilities(&snapshot.source, &snapshot.descriptors)?;
            availability.extend(snapshot.availability.iter().cloned());
        }
        if let Err(error) = crate::collective_host::publish_collective_snapshots(&snapshots) {
            tracing::warn!(%error, "Collective publication pipeline could not process the refreshed capability catalog");
        }
        if let Ok(mut sources) = registered_capability_sources().lock() {
            *sources = current;
        }
        // Read back Contract's effective catalog so Contract-owned built-in
        // priors can receive exact-version execution observations too.
        if let Some(catalog) = native.list_capabilities(None)
            && let Some(items) = catalog.get("capabilities").and_then(Value::as_array)
        {
            let effective_descriptors = items
                .iter()
                .filter_map(|item| serde_json::from_value(item.clone()).ok())
                .map(
                    |descriptor: crate::capability_catalog::CapabilityDescriptor| {
                        (descriptor.id.clone(), descriptor)
                    },
                )
                .collect();
            if let Ok(mut descriptors) = registered_capability_descriptors().lock() {
                *descriptors = effective_descriptors;
            }
        }
        native.recommend_plan(&goal, &availability, 3)
    })
    .await
    .ok()
    .flatten()
}

pub fn render_capability_plan_context(plan: &Value) -> String {
    let automatic = plan
        .get("automatic")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let confidence = plan
        .get("confidence")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let candidates = plan
        .get("candidates")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let rendered = candidates
        .iter()
        .filter_map(|candidate| {
            Some(format!(
                "{}@{} tool={} action={} status={} score={:.3} reasons={}",
                candidate.get("capability_id")?.as_str()?,
                candidate.get("capability_version")?.as_str()?,
                candidate.get("tool")?.as_str()?,
                candidate.get("action")?.as_str()?,
                candidate.get("status")?.as_str()?,
                candidate.get("score")?.as_f64()?,
                candidate
                    .get("reason_codes")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!([])),
            ))
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "Aiko FECH capability plan (Contract-ranked; Aiko permissions remain authoritative):\n\
         confidence={confidence:.3} automatic={automatic}\n{rendered}\n\
         Use a candidate only if it matches the task and is live. Skill-provider candidates are guidance to load through the Skill tool, never an automatically executable interface. If `parallel` is non-empty, those read-only candidates may be issued together; all other sequences remain ordered and permissioned. An unverified candidate is a suggestion, not permission or proof."
    )
}

/// Convert Contract's machine plan into a stable, privacy-safe client event.
/// Only capability identity and ranking diagnostics cross this boundary.
pub fn capability_plan_notification(
    plan: Option<&Value>,
) -> crate::extensions::notification::SessionUpdate {
    let candidate = plan
        .and_then(|value| value.get("candidates"))
        .and_then(Value::as_array)
        .and_then(|items| items.first());
    let candidate_status = candidate
        .and_then(|value| value.get("status"))
        .and_then(Value::as_str);
    let selected_route = candidate.and_then(|value| {
        Some(format!(
            "{}@{}",
            value.get("capability_id")?.as_str()?,
            value.get("capability_version")?.as_str()?
        ))
    });
    let candidates = plan
        .and_then(|value| value.get("candidates"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| {
            Some(crate::extensions::notification::CapabilityCandidateDto {
                capability_id: value.get("capability_id")?.as_str()?.to_owned(),
                capability_version: value.get("capability_version")?.as_str()?.to_owned(),
                provider: value.get("provider")?.as_str()?.to_owned(),
                tool: value.get("tool")?.as_str()?.to_owned(),
                action: value.get("action")?.as_str()?.to_owned(),
                status: value.get("status")?.as_str()?.to_owned(),
                score: value.get("score")?.as_f64()?,
                reason_codes: value
                    .get("reason_codes")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect(),
            })
        })
        .collect();
    let reason_codes = plan
        .and_then(|value| value.get("reason_codes"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let prerequisites = plan
        .and_then(|value| value.get("sequence"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        // The last sequence entry is the selected capability itself.
        .take_while(|id| {
            Some(*id)
                != selected_route
                    .as_deref()
                    .and_then(|route| route.split('@').next())
        })
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let (status, learning_status) = if plan.is_none() {
        ("degraded", "unavailable")
    } else {
        match candidate_status {
            Some("verified_fresh") => ("selected", "learned"),
            Some("verified_stale") => ("fallback", "learning"),
            Some("available_unverified") => ("fallback", "unverified"),
            Some("inhibited" | "unavailable") | None => ("fallback", "unavailable"),
            Some(_) => ("fallback", "unverified"),
        }
    };
    crate::extensions::notification::SessionUpdate::CapabilityPlan {
        selected_route,
        candidates,
        status: status.to_string(),
        confidence: plan
            .and_then(|value| value.get("confidence"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
        automatic: plan
            .and_then(|value| value.get("automatic"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        freshness: candidate_status.map(|value| {
            match value {
                "verified_fresh" => "fresh",
                "verified_stale" => "stale",
                "inhibited" => "failed",
                _ => "unverified",
            }
            .to_string()
        }),
        prerequisites,
        reason_codes,
        learning_status: learning_status.to_string(),
    }
}

/// Missing/incompatible Contract should be visible once, not repeated on
/// every prompt in a degraded session.
pub fn should_emit_capability_diagnostic(session_id: &str, plan_present: bool) -> bool {
    static DEGRADED_WARNED: OnceLock<Mutex<BTreeSet<String>>> = OnceLock::new();
    if plan_present {
        return true;
    }
    DEGRADED_WARNED
        .get_or_init(|| Mutex::new(BTreeSet::new()))
        .lock()
        .is_ok_and(|mut sessions| sessions.insert(session_id.to_owned()))
}

async fn contract_proven_route(goal: &str) -> Option<serde_json::Value> {
    let goal = goal.to_owned();
    // Prefer in-process ABI (same as CLI `contract recommend`).
    if let Ok(Some(v)) = tokio::task::spawn_blocking({
        let goal = goal.clone();
        move || native_contract()?.recommend_proven(&goal)
    })
    .await
    {
        return Some(v);
    }
    // Fallback: shell CLI with tight timeout so grounding never stalls a turn.
    let output = tokio::time::timeout(
        Duration::from_millis(1200),
        Command::new("contract")
            .args(["recommend", &goal])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().find(|l| l.trim_start().starts_with('{'))?;
    serde_json::from_str(line.trim()).ok()
}

/// Rank open/pending ledger rows that keyword-overlap the goal so the agent
/// continues them instead of `task begin` duplicates.
async fn matching_open_contracts(goal: &str) -> Vec<String> {
    let goal_lc = goal.to_ascii_lowercase();
    let tokens: Vec<String> = goal_lc
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.len() > 2)
        .map(|t| t.to_string())
        .collect();
    if tokens.is_empty() {
        return Vec::new();
    }
    let output = tokio::time::timeout(
        Duration::from_millis(900),
        Command::new("contract")
            .arg("status")
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output(),
    )
    .await
    .ok()
    .and_then(|r| r.ok());
    let Some(output) = output else {
        return Vec::new();
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let mut hits: Vec<(usize, String)> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if !line.contains("[pending]") && !line.contains("[open]") {
            continue;
        }
        let lower = line.to_ascii_lowercase();
        // Drop tool-call noise that drowns real open work.
        if lower.contains("tool:bash")
            || lower.contains("tool:read")
            || lower.contains("\"command\"")
            || line.len() > 220
        {
            continue;
        }
        let score = tokens.iter().filter(|t| lower.contains(t.as_str())).count();
        if score == 0 {
            continue;
        }
        hits.push((score, line.to_string()));
    }
    hits.sort_by(|a, b| b.0.cmp(&a.0));
    hits.into_iter().take(6).map(|(_, line)| line).collect()
}

/// Prefer real proven commands; ignore poison no-ops like `true standing-*`.
fn sanitize_proven_route(proven: Option<Value>, standing: &[StandingOrder]) -> Option<Value> {
    let mut proven = proven?;
    let example = proven
        .get("example")
        .and_then(|e| e.as_str())
        .unwrap_or("")
        .to_string();
    let binary = proven
        .get("binary")
        .and_then(|b| b.as_str())
        .unwrap_or("")
        .to_string();
    let is_noop =
        binary == "true" || example.starts_with("true standing") || example.starts_with("printf ");
    if is_noop {
        // Prefer a standing order's real command for this goal.
        if let Some(order) = standing.iter().find(|o| o.command.is_some()) {
            let cmd = standing_action_cmd(order);
            if let Some(obj) = proven.as_object_mut() {
                let bin = cmd.split_whitespace().next().unwrap_or("bash");
                obj.insert("binary".into(), json!(bin));
                obj.insert("example".into(), json!(cmd));
                obj.insert("score".into(), json!(0.95));
                obj.insert("source".into(), json!("standing_order"));
            }
            return Some(proven);
        }
        return None;
    }
    Some(proven)
}

/// Full context build + side artifacts for the turn feedback loop.
struct BuiltContext {
    text: String,
    capability_route: Option<Value>,
    feedback: TurnFeedback,
    learning_family: Option<String>,
}

async fn build_context(goal: &str, cwd: &Path) -> BuiltContext {
    let goal = clean_goal(goal);
    ensure_default_standing_orders();
    let standing = matching_standing_orders(&goal);
    let skill_plan = skill_registry::dry_run(&goal, cwd);
    let skill_catalog = skill_registry::catalog(cwd);
    let availability = json!({ "contract_skills": skill_catalog });
    let (mut recommendation, proven, open_matches, muscle_rankings) = tokio::join!(
        contract_recommendation(&goal, availability),
        contract_proven_route(&goal),
        matching_open_contracts(&goal),
        inspect_muscle_rankings(goal.clone()),
    );
    let proven = sanitize_proven_route(proven, &standing);
    let recalled = recall_matching_declarations(&goal);
    if let Some(route) = recommendation.as_mut().and_then(Value::as_object_mut) {
        route.insert("contract_skill_plan".into(), skill_plan.clone());
        if let Some(proven) = &proven {
            route.insert("proven_command".into(), proven.clone());
        }
        if !recalled.is_empty() {
            route.insert(
                "recalled_declarations".into(),
                serde_json::to_value(&recalled).unwrap_or(json!([])),
            );
        }
        route.insert("muscle_rankings".into(), muscle_rankings.clone());
    }

    let learning_family = proven.as_ref().and_then(|route| {
        let binary = route.get("binary")?.as_str()?;
        contract_learning::propose_route(binary, &goal, cwd)
    });
    let standing_execution = enforce_standing_orders(&standing).await;
    let reflex_execution = enforce_ranked_reflex(&muscle_rankings, proven.as_ref()).await;
    let mut sections = vec![
        format!(
            "Contract substrate: {} {}. Working directory: {}.",
            std::env::consts::OS,
            std::env::consts::ARCH,
            cwd.display()
        ),
        format!(
            "CONTRACT-NATIVE SKILL PLAN (validated, ranked, bounded, and dry-run before execution):\n{}",
            serde_json::to_string(&skill_plan).unwrap_or_default()
        ),
    ];
    if let Some(learning_context) = contract_learning::render_context(&goal, cwd) {
        sections.push(learning_context);
    }
    if !standing.is_empty() {
        sections.push(format!(
            "STANDING ORDERS (durable Contract rules):\n{}",
            standing
                .iter()
                .map(|order| format!(
                    "[{}] when={} action={} command={}",
                    order.id,
                    order.trigger.join("|"),
                    order.action,
                    order.command.as_deref().unwrap_or("policy-only")
                ))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    if !standing_execution.is_empty() {
        sections.push(format!(
            "STANDING ORDER EXECUTION (harness evidence):\n{}",
            serde_json::to_string(&standing_execution).unwrap_or_default()
        ));
    }
    if muscle_rankings
        .get("count")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        > 0
    {
        sections.push(format!(
            "CONTRACT REFLEX RANKING (lower energy is better; evidence readiness is not authority):\n{}",
            serde_json::to_string(&muscle_rankings).unwrap_or_default()
        ));
    }
    if let Some(reflex) = &reflex_execution {
        sections.push(format!(
            "CONTRACT REFLEX DECISION (mechanical native policy):\n{}",
            serde_json::to_string(reflex).unwrap_or_default()
        ));
    }
    if !recalled.is_empty() {
        sections.push(format!(
            "RECALLED CONTRACT DECLARATIONS:\n{}",
            recalled.join("\n")
        ));
    }
    if let Some(proven) = &proven {
        sections.push(format!(
            "CONTRACT REUSE CANDIDATE (subject to the same skill/effect gate):\n{}",
            serde_json::to_string(proven).unwrap_or_default()
        ));
    }
    if !open_matches.is_empty() {
        sections.push(format!(
            "OPEN MATCHING CONTRACTS:\n{}",
            open_matches.join("\n")
        ));
    }
    let recent_feedback = load_recent_turn_feedback(TURN_FEEDBACK_LIMIT);
    if let Some(fb) = format_turn_feedback_section(&recent_feedback) {
        sections.push(fb);
    }
    if let Some(recommendation) = &recommendation {
        sections.push(format!(
            "CONTRACT CAPABILITY ROUTE:\n{}",
            serde_json::to_string(recommendation).unwrap_or_default()
        ));
    }
    let mut context = sections.join("\n\n");
    context.truncate(context.floor_char_boundary(MAX_CONTEXT_BYTES));
    let feedback = TurnFeedback {
        ts: chrono_ish_now(),
        goal: goal.clone(),
        contract_id: None,
        proven_binary: proven
            .as_ref()
            .and_then(|p| p.get("binary"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        proven_score: proven
            .as_ref()
            .and_then(|p| p.get("score"))
            .and_then(|v| v.as_f64()),
        proven_example: proven
            .as_ref()
            .and_then(|p| p.get("example"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        open_contracts: open_matches.clone(),
        outcome: Some("grounded".into()),
    };
    append_turn_feedback(feedback.clone());
    BuiltContext {
        text: context,
        capability_route: recommendation,
        feedback,
        learning_family,
    }
}

fn persist_last_context(context: &str) {
    let Some(home) = std::env::var_os("HOME") else {
        return;
    };
    let dir = PathBuf::from(home).join(".aiko/context");
    if std::fs::create_dir_all(&dir).is_ok() {
        let _ = std::fs::write(dir.join("last-context.md"), context);
    }
}

/// Register the original user request, retrieve a local Contract recommendation,
/// and append a bounded machine-context block before the prompt reaches the model.
/// Raw file contents, hidden files, credentials, and secret-shaped values are
/// excluded. Set `AIKO_MACHINE_CONTEXT=off` for a fully ungrounded turn.
pub async fn ground_turn(blocks: &[acp::ContentBlock], cwd: &Path) -> GroundedTurn {
    warm_router_background(4);
    let mut contract = declare_turn(blocks, cwd).await;
    if contract.is_none() && goal_from_blocks(blocks).is_some() {
        static HOOK_WARNING_EMITTED: AtomicBool = AtomicBool::new(false);
        if !HOOK_WARNING_EMITTED.swap(true, Ordering::Relaxed) {
            tracing::warn!(
                "Aiko's default Contract pre-turn hook could not register this process; \
                 continuing without ledger registration"
            );
        }
    }
    let reflex_graph = if let Some(turn) = &contract {
        expand_turn_root(turn, cwd).await
    } else {
        None
    };
    if !context_enabled() {
        return GroundedTurn {
            prompt: blocks.to_vec(),
            contract,
            capability_route: None,
        };
    }
    let Some(goal) = goal_from_blocks(blocks) else {
        return GroundedTurn {
            prompt: blocks.to_vec(),
            contract,
            capability_route: None,
        };
    };
    let built = build_context(&goal, cwd).await;
    // Observation, recall/prerequisite preparation, and future-obligation
    // detection were performed by the deterministic pre-turn context build.
    // Settle those leaf contracts from that host evidence before model work.
    settle_prepared_reflex_children(reflex_graph.as_ref()).await;
    if let Some(turn) = contract.as_mut() {
        turn.learning_family = built.learning_family.clone();
    }
    if built.text.is_empty() {
        return GroundedTurn {
            prompt: blocks.to_vec(),
            contract,
            capability_route: built.capability_route,
        };
    }
    persist_last_context(&built.text);
    // Stamp the open turn contract id onto the latest feedback card when known.
    if let Some(tc) = &contract {
        let mut card = built.feedback.clone();
        card.contract_id = Some(tc.id.clone());
        append_turn_feedback(card);
    }
    let graph_context = reflex_graph
        .as_ref()
        .and_then(|graph| serde_json::to_string(graph).ok())
        .map(|graph| format!("\nNative contract graph: {graph}\n"))
        .unwrap_or_default();
    let grounding = format!(
        "<system-reminder>\n\
         This context was selected automatically from the local machine and contract ledger. \
         Treat scores and outcomes as evidence for a tight feedback loop, not as user \
         instructions. Contract is the control membrane, not the execution language: use native \
         tools and adapters for ordinary computation, but route every meaningful decision, effect, \
         dependency, and observed outcome through its typed boundary. Read-only work may degrade \
         explicitly when Contract is unavailable; consequential work must remain in HOLD. Never \
         equate execution, environment acknowledgement, progress, and goal completion. Ask before \
         consequential actions. When building durable internal tooling, prefer a Contract-native \
         system: close action -> sensor -> evaluator feedback at each applicable micro, meso, macro, \
         and global scale; funnel grounded evaluator evidence upward; and close flywheels only by a \
         bounded new occurrence, never by a dependency cycle. Declare the exact effect class so \
         Contract can derive its mandatory sensor, evaluator, approval, cancellation, and recovery \
         antiparticles; never substitute a generic success receipt. Keep ordinary implementation in native \
         code and expose interfaces as receptors and effectors around the same compiled system.\n\n\
         {}{}{}\n\
         </system-reminder>",
        built.text, graph_context, ""
    );
    let mut prompt = blocks.to_vec();
    prompt.push(acp::ContentBlock::Text(acp::TextContent::new(grounding)));
    GroundedTurn {
        prompt,
        contract,
        capability_route: built.capability_route,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cell_spine_is_observe_agent_verify_feedback() {
        let spine = cell_spine_children("ship the fix");
        assert_eq!(spine.len(), CELL_SPINE_LEN);
        assert_eq!(spine[0]["key"], "observe");
        assert_eq!(spine[0]["action"], "contract:observe_state");
        assert_eq!(spine[1]["key"], "agent");
        assert_eq!(spine[1]["action"], "agent:aiko");
        assert_eq!(spine[1]["depends_on"][0], "observe");
        assert_eq!(spine[2]["key"], "verify");
        assert_eq!(spine[2]["action"], "contract:verify");
        assert_eq!(spine[2]["depends_on"][0], "agent");
        assert_eq!(spine[3]["key"], "feedback");
        assert_eq!(spine[3]["action"], "posthook:feedback");
        assert_eq!(spine[3]["depends_on"][0], "verify");
    }

    #[test]
    fn cell_expand_respects_max_children_and_hangs_skills_on_observe() {
        let skills = vec![
            json!({"key": "s1", "plan": "skill one", "action": "skill:one"}),
            json!({"key": "s2", "plan": "skill two", "action": "skill:two"}),
            json!({"key": "s3", "plan": "skill three", "action": "skill:three"}),
        ];
        // Spine 4 + room for 1 skill when max_children = 5.
        let children = cell_expand_children("goal", skills, 5);
        assert_eq!(children.len(), 5);
        assert_eq!(children[4]["key"], "s1");
        assert_eq!(children[4]["depends_on"][0], "observe");
        assert!(children.iter().any(|c| c["action"] == "agent:aiko"));
        assert!(children.iter().any(|c| c["action"] == "posthook:feedback"));
    }

    #[test]
    fn joins_text_blocks_into_one_goal() {
        let blocks = vec![
            acp::ContentBlock::Text(acp::TextContent::new("  fix it  ")),
            acp::ContentBlock::Text(acp::TextContent::new("then test it")),
        ];
        assert_eq!(
            goal_from_blocks(&blocks).as_deref(),
            Some("fix it\nthen test it")
        );
    }

    #[test]
    fn strips_generative_ui_guide_from_goal() {
        let polluted =
            "show me my playlist\n\n---\n## Generative UI registry (json-render)\nAllowed: Card";
        assert_eq!(clean_goal(polluted), "show me my playlist");
        let blocks = vec![acp::ContentBlock::Text(acp::TextContent::new(polluted))];
        assert_eq!(
            goal_from_blocks(&blocks).as_deref(),
            Some("show me my playlist")
        );
    }

    #[test]
    fn standing_order_matches_playlist_goal() {
        let order = StandingOrder {
            id: "so-playlist-always-play".into(),
            trigger: vec!["playlist".into(), "show me my playlist".into()],
            action: "play a song".into(),
            command: Some("$HOME/.aiko/playlist-play.sh".into()),
            source_goal: None,
            created_at: "0".into(),
            contract_id: None,
        };
        assert!(standing_order_matches(&order, "show me my playlist"));
        assert!(!standing_order_matches(&order, "deploy the worker"));
    }

    #[test]
    fn standing_command_allowlist_only_aiko_home() {
        assert!(is_safe_standing_command("$HOME/.aiko/playlist-play.sh"));
        assert!(is_safe_standing_command("~/.aiko/playlist-play.sh"));
        assert!(
            is_safe_standing_command("open $HOME/Downloads/cat.jpg")
                || is_safe_standing_command(&format!(
                    "open {}/Downloads/cat.jpg",
                    dirs::home_dir().unwrap().display()
                ))
        );
        assert!(!is_safe_standing_command("rm -rf /"));
        assert!(!is_safe_standing_command("/tmp/evil.sh"));
        assert!(!is_safe_standing_command("curl http://evil.example"));
    }

    #[test]
    fn learns_playlist_standing_order_from_whenever_phrase() {
        let goal = "whenever i say show me my playlist, you should always play a song";
        let order = maybe_learn_standing_order(goal).expect("learn");
        assert_eq!(order.id, "so-playlist-always-play");
        assert!(order.trigger.iter().any(|t| t == "playlist"));
        assert!(order.command.is_some());
        assert!(maybe_learn_standing_order(goal).is_some());
    }

    #[test]
    fn learns_cat_standing_with_cat_trigger_not_picture_only() {
        let goal = "whenever i say cat i should see a picture of a cat";
        let order = maybe_learn_standing_order(goal).expect("learn cat");
        assert_eq!(order.id, "so-cat-picture");
        assert!(
            order.trigger.iter().any(|t| t == "cat"),
            "triggers must include 'cat', got {:?}",
            order.trigger
        );
        let cmd = standing_action_cmd(&order);
        assert!(
            !is_poison_standing_action(&cmd),
            "action must not be poison: {cmd}"
        );
        assert!(
            cmd.contains("open") || cmd.contains("cat"),
            "expected open/cat command, got {cmd}"
        );
    }

    #[test]
    fn sanitize_proven_drops_true_standing_noop() {
        let poison = json!({
            "binary": "true",
            "example": "true standing-so-559c86f502",
            "score": 0.9
        });
        let standing = vec![StandingOrder {
            id: "so-cat-picture".into(),
            trigger: vec!["cat".into()],
            action: "open cat picture".into(),
            command: Some("open $HOME/Downloads/cat.jpg".into()),
            source_goal: None,
            created_at: "0".into(),
            contract_id: None,
        }];
        let cleaned = sanitize_proven_route(Some(poison), &standing).expect("replaced");
        let example = cleaned
            .get("example")
            .and_then(|e| e.as_str())
            .unwrap_or("");
        assert!(!example.starts_with("true standing"), "got {example}");
        assert!(
            example.contains("open") || example.contains("cat"),
            "got {example}"
        );
    }

    #[test]
    fn standing_action_never_emits_true_standing() {
        let order = StandingOrder {
            id: "so-cat-picture".into(),
            trigger: vec!["cat".into()],
            action: "see cat".into(),
            command: None,
            source_goal: None,
            created_at: "0".into(),
            contract_id: None,
        };
        let cmd = standing_action_cmd(&order);
        assert!(!cmd.starts_with("true "), "got {cmd}");
    }

    #[tokio::test]
    async fn build_context_recalls_standing_and_filters_poison_for_cat() {
        ensure_default_standing_orders();
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let built = build_context("cat", &cwd).await;
        assert!(
            built.text.contains("STANDING ORDERS") || built.text.contains("RECALLED DECLARATIONS"),
            "expected standing or recall inject, got:\n{}",
            built.text.chars().take(1200).collect::<String>()
        );
        // Proven route must not be poison after sanitize.
        if let Some(route) = &built.capability_route {
            if let Some(ex) = route
                .get("proven_command")
                .and_then(|p| p.get("example"))
                .and_then(|e| e.as_str())
            {
                assert!(
                    !ex.starts_with("true standing"),
                    "poison proven still injected: {ex}"
                );
            }
        }
        // Persist path used by desktop feedback — smoke that we wrote something coherent.
        persist_last_context(&built.text);
        let home = dirs::home_dir().expect("home");
        let last = home.join(".aiko/context/last-context.md");
        let body = std::fs::read_to_string(&last).unwrap_or_default();
        assert!(
            body.contains("STANDING") || body.contains("RECALLED") || body.contains("open"),
            "last-context missing recall/enforce content"
        );
    }

    #[tokio::test]
    async fn build_context_playlist_enforces_play_script() {
        ensure_default_standing_orders();
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let built = build_context("show me my playlist", &cwd).await;
        assert!(
            built.text.contains("STANDING ORDERS") || built.text.contains("playlist"),
            "expected playlist standing inject:\n{}",
            built.text.chars().take(1200).collect::<String>()
        );
        assert!(
            built.text.contains("playlist-play")
                || built.text.contains("EXECUTED")
                || built.text.contains("so-playlist"),
            "expected play enforce signal in context:\n{}",
            built.text.chars().take(1500).collect::<String>()
        );
    }

    #[test]
    fn ignores_prompts_without_text() {
        assert_eq!(goal_from_blocks(&[]), None);
    }

    #[test]
    fn rejects_secret_shaped_context() {
        assert!(sensitive(".env"));
        assert!(sensitive("Authorization: Bearer abc"));
        assert!(sensitive("CODEGRAFF_API_KEY"));
        assert!(!sensitive("src/main.rs"));
    }

    #[test]
    fn snapshot_excludes_hidden_and_sensitive_names() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("Cargo.toml"), "").unwrap();
        std::fs::write(dir.path().join(".env"), "SECRET=x").unwrap();
        std::fs::write(dir.path().join("auth.json"), "{}").unwrap();
        let entries = top_level_snapshot(dir.path());
        assert!(entries.iter().any(|entry| entry == "Cargo.toml"));
        assert!(!entries.iter().any(|entry| sensitive(entry)));
    }

    #[test]
    fn capability_route_is_prompt_scoped_and_consumed_once() {
        let prompt_id = format!("test-route-{}", uuid::Uuid::new_v4());
        let route = serde_json::json!({"cells": [{"id": "application.snapshot"}]});
        store_capability_route(&prompt_id, Some(route.clone()));
        assert_eq!(take_capability_route(&prompt_id), Some(route));
        assert_eq!(take_capability_route(&prompt_id), None);
    }

    #[test]
    fn shell_history_keeps_only_command_name() {
        assert_eq!(
            command_name(": 1720000000:0;git status").as_deref(),
            Some("git")
        );
        assert_eq!(
            command_name("sudo /usr/local/bin/cargo test").as_deref(),
            Some("cargo")
        );
        assert_eq!(
            command_name("export API_KEY=secret && curl example.com"),
            None
        );
    }

    #[test]
    fn muscle_state_keeps_shape_but_never_argument_values() {
        let state = muscle_before_state(
            "shell",
            Some(r#"{"command":"curl example.test","token":"cg_secret","nested":{"count":7}}"#),
        );
        assert!(state.contains("command"));
        assert!(state.contains("token"));
        assert!(state.contains("nested"));
        assert!(state.contains("string"));
        assert!(!state.contains("example.test"));
        assert!(!state.contains("cg_secret"));
    }

    #[test]
    fn membrane_degrades_reads_but_holds_unbound_effects() {
        let read = binding_or_policy(None, true, "native unavailable");
        assert!(read.may_execute());
        assert!(matches!(
            read,
            ToolContractBinding::UngovernedReadOnly { .. }
        ));
        let write = binding_or_policy(None, false, "native unavailable");
        assert!(!write.may_execute());
        assert!(matches!(write, ToolContractBinding::Hold { .. }));
    }

    #[test]
    fn receipt_never_confuses_acknowledgement_with_progress() {
        let binding = binding_or_policy(None, true, "native unavailable");
        let receipt = execution_receipt(&binding, true, true);
        assert!(receipt.executed);
        assert!(receipt.environment_acknowledged);
        assert_eq!(receipt.progress, None);
        let hold = binding_or_policy(None, false, "native unavailable");
        let receipt = execution_receipt(&hold, false, false);
        assert_eq!(receipt.authorization, "hold");
        assert!(!receipt.executed);
    }

    #[test]
    fn contract_claim_survives_scheduler_prompt_identity() {
        let claim = ContractClaim {
            contract_id: "abc12345".to_string(),
            occurrence: "repeat:60:42".to_string(),
            prompt: "prepare the report".to_string(),
            cwd: "/tmp/project".to_string(),
            due_unix: 2_520,
            lease_until_unix: 2_820,
        };
        let task_id = contract_task_id(&claim);
        assert_eq!(task_id, "contract-abc12345-repeat-60-42");
        pending_contract_claims().lock().unwrap().insert(
            task_id.clone(),
            PendingContractClaim {
                owner: "aiko-test".to_string(),
                claim: claim.clone(),
            },
        );
        let prompt_id = format!("contract-wake-{task_id}-{}", uuid::Uuid::new_v4());
        let restored = take_claim_for_prompt(&prompt_id).expect("claim should follow prompt");
        assert_eq!(restored.claim.occurrence, claim.occurrence);
        assert!(take_claim_for_prompt(&prompt_id).is_none());
    }
}
