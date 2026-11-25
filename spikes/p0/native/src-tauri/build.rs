#[cfg(feature = "p0-hosted-provider")]
#[path = "src/hosted_origin.rs"]
mod hosted_origin;

fn main() {
    let windows = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows");
    let windows_provider = windows && std::env::var_os("CARGO_FEATURE_P0_LOCAL_PROVIDER").is_some();
    #[cfg(feature = "p0-hosted-provider")]
    {
        let android_provider = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android")
            && std::env::var_os("CARGO_FEATURE_P0_ANDROID_PROVIDER_PREFLIGHT").is_some();
        assert!(
            windows_provider || android_provider,
            "p0-hosted-provider requires p0-local-provider on Windows or p0-android-provider-preflight on Android"
        );
        println!("cargo:rerun-if-env-changed=KLAXON_P0_HOSTED_ORIGIN");
        assert!(
            std::env::var("KLAXON_P0_HOSTED_ORIGIN")
                .is_ok_and(|origin| hosted_origin::is_canonical_origin(&origin)),
            "p0-hosted-provider requires KLAXON_P0_HOSTED_ORIGIN to be a canonical https://slug.convex.cloud origin"
        );
    }
    println!("cargo:rerun-if-changed=../.frontend/index.html");
    if windows && std::env::var_os("CARGO_FEATURE_P0_SESSION").is_some() {
        println!("cargo:rerun-if-changed=../.run/windows-session-frontend/index.html");
    }
    if windows_provider {
        let frontend = if cfg!(feature = "p0-hosted-provider") {
            "hosted-provider-frontend"
        } else {
            "local-provider-frontend"
        };
        println!("cargo:rerun-if-changed=../.run/{frontend}");
    }
    tauri_build::build();
}
