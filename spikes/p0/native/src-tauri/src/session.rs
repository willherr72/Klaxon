use std::collections::BTreeMap;
use tauri::{plugin::PluginHandle, Builder, Manager, State, WebviewWindow, Wry};

struct FixturePlugin(PluginHandle<Wry>);

#[tauri::command]
async fn fixture_session(
    window: WebviewWindow,
    plugin: State<'_, FixturePlugin>,
    operation: String,
) -> Result<&'static str, &'static str> {
    if window.label() != "main"
        || window
            .url()
            .map(|u| u.origin().ascii_serialization())
            .ok()
            .as_deref()
            != Some("http://tauri.localhost")
        || !matches!(operation.as_str(), "seed" | "resume" | "sign-out")
    {
        return Err("unavailable");
    }
    let reply: String = plugin
        .0
        .run_mobile_plugin_async("change", BTreeMap::from([("operation", operation)]))
        .await
        .map_err(|_| "unavailable")?;
    // Never forward a native payload or diagnostic verbatim to the web layer.
    match reply.as_str() {
        "fixture-ready" => Ok("fixture-ready"),
        "authenticated" => Ok("authenticated"),
        "signed-out" => Ok("signed-out"),
        _ => Err("unavailable"),
    }
}

pub fn install(builder: Builder<Wry>) -> Builder<Wry> {
    builder
        .plugin(
            tauri::plugin::Builder::<Wry>::new("session-fixture")
                .setup(|app, api| {
                    app.manage(FixturePlugin(
                        api.register_android_plugin("dev.klaxon.p0native", "SessionPlugin")?,
                    ));
                    Ok(())
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![fixture_session])
}
