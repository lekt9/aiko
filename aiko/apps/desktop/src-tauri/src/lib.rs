mod console;
mod native_api;
mod runtime;
pub mod stack;
mod telegram;
mod tunnel;
mod ui_store;
mod webhost;

use stack::StackSupervisor;

use native_api::{native_agent_mail_url, native_api_request, reveal_runtime_help};
use runtime::RuntimeSupervisor;
use tunnel::{start_tunnel, stop_tunnel, tunnel_status, TunnelState};
use webhost::WebHostInfo;
use telegram::{
    approve_telegram_pair_code, get_telegram_bridge_log, get_telegram_settings,
    save_telegram_bot_token,
};
use ui_store::{
    ui_store_get, ui_store_list, ui_store_put, ui_store_put_data, ui_store_rank,
    ui_store_resolve, ui_store_root, ui_store_routes, ui_store_seed_catalog,
};
use tauri::{Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(RuntimeSupervisor::default())
        .manage(StackSupervisor::default())
        .manage(WebHostInfo::default())
        .manage(TunnelState::default())
        .setup(|app| {
            runtime::start(app.handle().clone());
            // Self-contained: adopt or start the Manus backend (and its
            // databases) so opening the app is sufficient. Runs concurrently
            // with the webhost; the UI degrades honestly until ready.
            let stack_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let backend_url = std::env::var("AIKO_BACKEND_URL")
                    .unwrap_or_else(|_| webhost::DEFAULT_BACKEND.to_string());
                let resources = stack_handle.path().resource_dir().ok();
                let supervisor = stack_handle.state::<StackSupervisor>();
                match stack::ensure(&backend_url, resources, Some(&supervisor)).await {
                    stack::StackOutcome::Adopted => {
                        println!("Aiko stack: adopted running backend at {backend_url}");
                    }
                    stack::StackOutcome::Started => {
                        println!("Aiko stack: started backend at {backend_url}");
                    }
                    stack::StackOutcome::Unavailable(reason) => {
                        eprintln!("Aiko stack: backend unavailable — {reason}");
                    }
                }
            });
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                webhost::launch(handle.clone()).await;
                let tunnel_requested = std::env::var("AIKO_TUNNEL")
                    .map(|value| matches!(value.as_str(), "1" | "true" | "quick"))
                    .unwrap_or(false);
                if tunnel_requested {
                    if let Err(error) = tunnel::start(&handle).await {
                        eprintln!("Aiko tunnel failed to start: {error}");
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            native_api_request,
            native_agent_mail_url,
            reveal_runtime_help,
            get_telegram_settings,
            save_telegram_bot_token,
            approve_telegram_pair_code,
            get_telegram_bridge_log,
            ui_store_list,
            ui_store_get,
            ui_store_put,
            ui_store_put_data,
            ui_store_resolve,
            ui_store_routes,
            ui_store_root,
            ui_store_rank,
            ui_store_seed_catalog,
            start_tunnel,
            stop_tunnel,
            tunnel_status
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Aiko Desktop");
    app.run(|handle, event| {
        if matches!(event, RunEvent::Exit) {
            tunnel::stop_blocking(handle);
            handle.state::<StackSupervisor>().stop();
            runtime::stop(handle);
        }
    });
}
