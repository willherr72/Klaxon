use crate::refresh_response::{self, Grant};
use jni::{
    objects::{JObject, JObjectArray, JString},
    sys::jobjectArray,
    JNIEnv,
};
use std::collections::BTreeMap;
use tauri::{plugin::PluginHandle, Builder, Manager, State, WebviewWindow, Wry};

struct FixturePlugin(PluginHandle<Wry>);

// Called only by the native fixture plugin. Null is invalid, an empty array is definitive noSession.
#[no_mangle]
pub extern "system" fn Java_dev_klaxon_p0native_SessionPlugin_decodeRefresh(
    mut env: JNIEnv<'_>,
    _plugin: JObject<'_>,
    body: JString<'_>,
) -> jobjectArray {
    decode_response(&mut env, body, refresh_response::decode)
}

// Called only by the native fixture plugin. Null means sign-in did not produce a grant.
#[no_mangle]
pub extern "system" fn Java_dev_klaxon_p0native_SessionPlugin_decodeSignIn(
    mut env: JNIEnv<'_>,
    _plugin: JObject<'_>,
    body: JString<'_>,
    expected_owner: JString<'_>,
) -> jobjectArray {
    let expected_owner: String = match env.get_string(&expected_owner) {
        Ok(owner) => owner.into(),
        Err(_) => return std::ptr::null_mut(),
    };
    decode_response(&mut env, body, |body| {
        refresh_response::decode_sign_in(body, &expected_owner).map(Some)
    })
}

fn decode_response(
    env: &mut JNIEnv<'_>,
    body: JString<'_>,
    decode: impl FnOnce(&[u8]) -> Result<Option<Grant>, ()>,
) -> jobjectArray {
    let reply = (|| {
        let body: String = env.get_string(&body).ok()?.into();
        let grant = decode(body.as_bytes()).ok()?;
        let fields: &[&str] = match grant.as_ref() {
            Some(grant) => &[&grant.access_token, &grant.refresh_token, &grant.user_id],
            None => &[],
        };
        let array = env
            .new_object_array(fields.len() as i32, "java/lang/String", JObject::null())
            .ok()?;
        for (index, field) in fields.iter().enumerate() {
            env.set_object_array_element(&array, index as i32, env.new_string(field).ok()?)
                .ok()?;
        }
        Some(array)
    })();
    reply.map_or(std::ptr::null_mut(), JObjectArray::into_raw)
}

#[tauri::command]
async fn fixture_session(
    window: WebviewWindow,
    plugin: State<'_, FixturePlugin>,
    operation: String,
) -> Result<&'static str, &'static str> {
    if !crate::allows_fixture(&window, &operation) {
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
        "retry-required" => Ok("retry-required"),
        "signed-out" => Ok("signed-out"),
        _ => Err("unavailable"),
    }
}

#[tauri::command]
async fn fixture_sdk_access(
    window: WebviewWindow,
    plugin: State<'_, FixturePlugin>,
) -> Result<&'static str, &'static str> {
    if !crate::is_fixture_window(&window) {
        return Err("unavailable");
    }
    let reply: String = plugin
        .0
        .run_mobile_plugin_async("sdkAccess", ())
        .await
        .map_err(|_| "unavailable")?;
    match reply.as_str() {
        "p0-inert-access-a" => Ok("p0-inert-access-a"),
        crate::ROTATED_OWNER_A_ACCESS => Ok(crate::ROTATED_OWNER_A_ACCESS),
        "p0-inert-access-b" => Ok("p0-inert-access-b"),
        "signed-out" => Err("signed-out"),
        "retry-required" => Err("retry-required"),
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
        .invoke_handler(tauri::generate_handler![
            fixture_session,
            fixture_sdk_access
        ])
}
