use crate::native_api;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const STARTUP_ATTEMPTS: usize = 40;
const STARTUP_INTERVAL: Duration = Duration::from_millis(250);

fn bundled_contract_library<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    #[cfg(target_os = "windows")]
    const NAMES: &[&str] = &["contract.dll", "libcontract.dll"];
    #[cfg(target_os = "macos")]
    const NAMES: &[&str] = &["libcontract.dylib"];
    #[cfg(all(unix, not(target_os = "macos")))]
    const NAMES: &[&str] = &["libcontract.so"];
    let resource_dir = app.path().resource_dir().ok()?;
    // "contract/" is the mapped location (tauri.conf.json resources map);
    // "resources/contract/" is where an unmapped glob lands. Accept either so
    // a packaging change degrades to the fallback search, not silent absence.
    let resource_dir = &resource_dir;
    ["contract", "resources/contract"]
        .iter()
        .flat_map(|dir| NAMES.iter().map(move |name| resource_dir.join(dir).join(name)))
        .find(|path| path.is_file())
}

#[derive(Default)]
pub struct RuntimeSupervisor {
    native_child: Mutex<Option<CommandChild>>,
    leader_child: Mutex<Option<CommandChild>>,
}

impl RuntimeSupervisor {
    fn replace_native(&self, child: CommandChild) {
        if let Ok(mut slot) = self.native_child.lock() {
            *slot = Some(child);
        }
    }

    fn replace_leader(&self, child: CommandChild) {
        if let Ok(mut slot) = self.leader_child.lock() {
            *slot = Some(child);
        }
    }

    fn stop(&self) {
        let native = self
            .native_child
            .lock()
            .ok()
            .and_then(|mut slot| slot.take());
        let leader = self
            .leader_child
            .lock()
            .ok()
            .and_then(|mut slot| slot.take());
        if let Some(child) = native {
            let _ = child.kill();
        }
        if let Some(child) = leader {
            let _ = child.kill();
        }
    }
}

fn watch_process(
    mut events: tauri::async_runtime::Receiver<CommandEvent>,
    label: &'static str,
) {
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Error(error) => eprintln!("Aiko {label} error: {error}"),
                CommandEvent::Terminated(status) if status.code != Some(0) => {
                    eprintln!("Aiko {label} stopped: {:?}", status.code);
                }
                CommandEvent::Stdout(_) | CommandEvent::Stderr(_) => {}
                _ => {}
            }
        }
    });
}

pub fn start<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        if !native_api::runtime_available().await {
            let mut command = match app.shell().sidecar("aiko") {
                Ok(command) => command.args(["native", "serve"]),
                Err(error) => {
                    eprintln!("Aiko Desktop could not resolve its runtime: {error}");
                    return;
                }
            };
            if let Some(contract) = bundled_contract_library(&app) {
                command = command.env("AIKO_CONTRACT_LIBRARY", contract);
            }
            let (events, child) = match command.spawn() {
                Ok(process) => process,
                Err(error) => {
                    eprintln!("Aiko Desktop could not start its runtime: {error}");
                    return;
                }
            };
            app.state::<RuntimeSupervisor>().replace_native(child);
            watch_process(events, "native runtime");

            for _ in 0..STARTUP_ATTEMPTS {
                if native_api::runtime_available().await {
                    break;
                }
                tokio::time::sleep(STARTUP_INTERVAL).await;
            }
            if !native_api::runtime_available().await {
                eprintln!("Aiko Desktop runtime did not become ready within 10 seconds.");
                app.state::<RuntimeSupervisor>().stop();
                return;
            }
        }

        let mut command = match app.shell().sidecar("aiko") {
            Ok(command) => command.args([
                "agent",
                "leader",
                "--no-exit-on-disconnect",
                "--relay-on-demand",
                "--no-auto-update",
            ]),
            Err(error) => {
                eprintln!("Aiko Desktop could not resolve its agent harness: {error}");
                return;
            }
        };
        if let Some(contract) = bundled_contract_library(&app) {
            command = command.env("AIKO_CONTRACT_LIBRARY", contract);
        }
        let (events, child) = match command.spawn() {
            Ok(process) => process,
            Err(error) => {
                eprintln!("Aiko Desktop could not start its agent harness: {error}");
                return;
            }
        };
        app.state::<RuntimeSupervisor>().replace_leader(child);
        watch_process(events, "agent harness");
    });
}

pub fn stop<R: Runtime>(app: &AppHandle<R>) {
    app.state::<RuntimeSupervisor>().stop();
}
