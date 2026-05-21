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

    tauri_build::build()
}
