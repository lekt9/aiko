mod native_api;
mod runtime;
mod telegram;
mod ui_store;

use native_api::{native_agent_mail_url, native_api_request, reveal_runtime_help};
use runtime::RuntimeSupervisor;
use telegram::{
    approve_telegram_pair_code, get_telegram_bridge_log, get_telegram_settings,
    save_telegram_bot_token,
};
use ui_store::{
    ui_store_get, ui_store_list, ui_store_put, ui_store_put_data, ui_store_rank,
    ui_store_resolve, ui_store_root, ui_store_routes, ui_store_seed_catalog,
};
use tauri::RunEvent;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(RuntimeSupervisor::default())
        .setup(|app| {
            runtime::start(app.handle().clone());
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
            ui_store_seed_catalog
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Aiko Desktop");
    app.run(|handle, event| {
        if matches!(event, RunEvent::Exit) {
            runtime::stop(handle);
        }
    });
}
