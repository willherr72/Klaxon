fn main() {
    println!("cargo:rerun-if-changed=../.frontend/index.html");
    if std::env::var_os("CARGO_FEATURE_P0_SESSION").is_some()
        && std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
    {
        println!("cargo:rerun-if-changed=../.run/windows-session-frontend/index.html");
    }
    tauri_build::build();
}
