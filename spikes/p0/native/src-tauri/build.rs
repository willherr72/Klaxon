fn main() {
    println!("cargo:rerun-if-changed=../.frontend/index.html");
    tauri_build::build();
}
