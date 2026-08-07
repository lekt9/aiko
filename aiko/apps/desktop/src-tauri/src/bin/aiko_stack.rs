//! `cargo run --bin aiko-stack` — the runnable witness that Aiko Desktop is
//! self-contained. Runs the exact supervisor the app runs: adopt a live
//! backend, or bring up databases + backend, and exit 0 only when the backend
//! actually answers. Children are left detached so the stack outlives this
//! process.

use aiko_desktop_lib::stack;

fn main() {
    let backend_url = std::env::var("AIKO_BACKEND_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:8000".to_string());
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    match runtime.block_on(stack::ensure(&backend_url, None, None)) {
        stack::StackOutcome::Adopted => {
            println!("aiko-stack: backend already answering at {backend_url} — adopted");
        }
        stack::StackOutcome::Started => {
            println!("aiko-stack: stack started; backend answering at {backend_url}");
        }
        stack::StackOutcome::Unavailable(reason) => {
            eprintln!("aiko-stack: NOT self-contained here — {reason}");
            std::process::exit(1);
        }
    }
}
