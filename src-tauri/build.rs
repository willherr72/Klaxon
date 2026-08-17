fn main() {
    // Android: force `libc++_shared.so` into the cdylib's DT_NEEDED list.
    // Something in our crate graph (wry's Android bindings or one of
    // iroh's deps) statically pulls in C++ that references
    // `__cxa_pure_virtual`, but the linker drops the libc++_shared
    // dependency under `--as-needed` because nothing in *our* Rust code
    // references it directly. Result at runtime: `dlopen` on the cdylib
    // fails with "cannot locate symbol __cxa_pure_virtual".
    //
    // We can't set this via `.cargo/config.toml` because Tauri's mobile
    // build sets `RUSTFLAGS` env, which makes Cargo ignore the config's
    // `rustflags` array entirely. Build-script-emitted link args dodge
    // that override.
    let target = std::env::var("TARGET").unwrap_or_default();
    if target.contains("android") {
        println!("cargo:rustc-link-arg=-Wl,--no-as-needed");
        println!("cargo:rustc-link-arg=-lc++_shared");
        println!("cargo:rustc-link-arg=-Wl,--as-needed");
    }

    // Hand the bundle identifier to the crate so the log file can be
    // written to the same directory Tauri resolves for app data. Logging is
    // initialized before the app exists, so it cannot ask the path
    // resolver, and a hardcoded copy would silently diverge — during the
    // 2026-08-17 drill it did exactly that, writing logs under
    // `com.klaxon.app` while the instance's data lived under
    // `com.klaxon.drill`. Reading the one source of truth removes the
    // possibility.
    println!("cargo:rerun-if-changed=tauri.conf.json");
    //
    // Panics rather than falling back to a literal: a default here would be
    // the very hardcoded copy this exists to eliminate, and it would drift
    // silently. A build script is the one place where failing loudly costs
    // nothing. Note this reads tauri.conf.json only — an identifier
    // overridden via TAURI_CONFIG or a tauri.<platform>.conf.json overlay
    // (neither used here) would not be seen.
    let conf = std::fs::read_to_string("tauri.conf.json")
        .expect("build.rs: cannot read tauri.conf.json to resolve the bundle identifier");
    let identifier = conf
        .split("\"identifier\"")
        .nth(1)
        .and_then(|rest| rest.split('"').nth(1))
        .filter(|id| !id.is_empty())
        .expect("build.rs: could not parse \"identifier\" out of tauri.conf.json");
    println!("cargo:rustc-env=KLAXON_IDENTIFIER={identifier}");

    tauri_build::build()
}
