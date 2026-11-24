#[cfg(all(target_os = "android", feature = "p0-session"))]
mod session;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(all(target_os = "android", feature = "p0-session"))]
    let builder = session::install(builder);
    builder
        .run(tauri::generate_context!())
        .expect("P0 native host failed to start");
}
