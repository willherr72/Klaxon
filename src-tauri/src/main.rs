#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    if std::env::args().any(|arg| arg == "--mcp") {
        if let Err(error) = klaxon_lib::agent::run_bridge(std::env::args().collect()) {
            eprintln!("Klaxon MCP: {error}. Keep Klaxon open and check Settings → Agent access.");
            std::process::exit(1);
        }
        return;
    }
    klaxon_lib::run()
}
