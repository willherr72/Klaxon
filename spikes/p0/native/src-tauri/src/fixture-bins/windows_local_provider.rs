#[cfg(not(windows))]
compile_error!("The P0 local provider fixture is Windows-only");

fn main() {
    #[cfg(windows)]
    klaxon_p0_native_lib::run_windows_local_provider();
}
