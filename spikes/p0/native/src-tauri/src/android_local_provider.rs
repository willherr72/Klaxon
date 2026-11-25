use crate::{
    preflight_loopback,
    refresh_response::{self, Grant},
};
use jni::{
    objects::{JByteArray, JObject, JObjectArray, JString},
    sys::{jboolean, jobjectArray},
    JNIEnv,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{plugin::PluginHandle, Builder, Manager, State, WebviewWindow, Wry};

const MUTATION_URL: &str = "http://127.0.0.1:3210/api/mutation";
const RETRY: &str = "retry-required";
const SIGNED_OUT: &str = "signed-out";
const UNAVAILABLE: &str = "unavailable";
const MAX_INPUT_BYTES: usize = 4096;

struct LocalProviderPlugin(PluginHandle<Wry>);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SignInInput {
    username: String,
    password: String,
    owner: String,
}

fn sign_in_input(bytes: &[u8]) -> Result<SignInInput, &'static str> {
    if bytes.len() > MAX_INPUT_BYTES
        || bytes.iter().find(|byte| !byte.is_ascii_whitespace()) != Some(&b'{')
    {
        return Err(UNAVAILABLE);
    }
    let input: SignInInput = serde_json::from_slice(bytes).map_err(|_| UNAVAILABLE)?;
    if [&input.username, &input.password, &input.owner]
        .iter()
        .any(|field| field.trim().is_empty())
    {
        return Err(UNAVAILABLE);
    }
    Ok(input)
}

fn mutation(path: &'static str, args: Value) -> Result<(u16, Vec<u8>), &'static str> {
    let request = json!({"path": path, "format": "convex_encoded_json", "args": [args]});
    preflight_loopback::post_mutation(MUTATION_URL, &request)
}

fn successful_body((status, body): (u16, Vec<u8>)) -> Result<Vec<u8>, &'static str> {
    if status != 200 {
        return Err(RETRY);
    }
    Ok(body)
}

// Private Kotlin calls, made from the fixture's worker. No provider body or
// unfiltered error crosses into Tauri IPC.
#[no_mangle]
pub extern "system" fn Java_dev_klaxon_p0native_LocalProviderPlugin_providerSignIn(
    mut env: JNIEnv<'_>,
    _plugin: JObject<'_>,
    input: JByteArray<'_>,
) -> jobjectArray {
    let result = (|| {
        let mut bytes = env.convert_byte_array(input).map_err(|_| UNAVAILABLE)?;
        let input = sign_in_input(&bytes);
        bytes.fill(0);
        let SignInInput {
            username,
            password,
            owner,
        } = input?;
        let body = successful_body(mutation(
            "auth:signInWithUsernamePassword",
            json!({"username": username, "password": password}),
        )?)?;
        refresh_response::decode_sign_in(&body, &owner)
            .map(Some)
            .map_err(|_| UNAVAILABLE)
    })();
    reply_array(&mut env, result)
}

#[no_mangle]
pub extern "system" fn Java_dev_klaxon_p0native_LocalProviderPlugin_providerRefresh(
    mut env: JNIEnv<'_>,
    _plugin: JObject<'_>,
    refresh: JString<'_>,
) -> jobjectArray {
    let result = (|| {
        let refresh: String = env.get_string(&refresh).map_err(|_| UNAVAILABLE)?.into();
        let body = successful_body(mutation(
            "auth:refreshSession",
            json!({"refreshToken": refresh}),
        )?)?;
        refresh_response::decode(&body).map_err(|_| UNAVAILABLE)
    })();
    reply_array(&mut env, result)
}

#[no_mangle]
pub extern "system" fn Java_dev_klaxon_p0native_LocalProviderPlugin_providerSignOut(
    mut env: JNIEnv<'_>,
    _plugin: JObject<'_>,
    refresh: JString<'_>,
) -> jboolean {
    let Ok(refresh) = env.get_string(&refresh) else {
        return 0;
    };
    let refresh: String = refresh.into();
    mutation("auth:signOut", json!({"refreshToken": refresh}))
        .is_ok_and(|(status, body)| {
            status == 200 && refresh_response::acknowledged_sign_out(status.into(), &body)
        })
        .into()
}

fn reply_array(env: &mut JNIEnv<'_>, result: Result<Option<Grant>, &'static str>) -> jobjectArray {
    let fields: &[&str] = match &result {
        Ok(Some(grant)) => &[
            "grant",
            &grant.access_token,
            &grant.refresh_token,
            &grant.user_id,
        ],
        Ok(None) => &["no-session"],
        Err(status) => &[status],
    };
    let reply = (|| {
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

async fn call(
    window: WebviewWindow,
    plugin: State<'_, LocalProviderPlugin>,
    command: &'static str,
) -> Result<Vec<String>, &'static str> {
    if !crate::is_fixture_window(&window) {
        return Err(UNAVAILABLE);
    }
    let result: Vec<String> = plugin
        .0
        .run_mobile_plugin_async(command, ())
        .await
        .map_err(|_| UNAVAILABLE)?;
    match result.as_slice() {
        [status] if status == RETRY => Err(RETRY),
        [status] if status == UNAVAILABLE => Err(UNAVAILABLE),
        _ => Ok(result),
    }
}

#[tauri::command]
async fn local_sign_in(
    window: WebviewWindow,
    plugin: State<'_, LocalProviderPlugin>,
) -> Result<&'static str, &'static str> {
    match call(window, plugin, "signIn").await?.as_slice() {
        [status] if status == "fixture-ready" => Ok("fixture-ready"),
        _ => Err(UNAVAILABLE),
    }
}

#[tauri::command]
async fn local_resume(
    window: WebviewWindow,
    plugin: State<'_, LocalProviderPlugin>,
) -> Result<&'static str, &'static str> {
    match call(window, plugin, "resume").await?.as_slice() {
        [status] if status == "authenticated" => Ok("authenticated"),
        [status] if status == SIGNED_OUT => Ok(SIGNED_OUT),
        _ => Err(UNAVAILABLE),
    }
}

#[tauri::command]
async fn local_access(
    window: WebviewWindow,
    plugin: State<'_, LocalProviderPlugin>,
    force_refresh: bool,
) -> Result<String, &'static str> {
    if force_refresh {
        return Err(UNAVAILABLE);
    }
    match call(window, plugin, "access").await?.as_mut_slice() {
        [status, access] if status == "access" => Ok(std::mem::take(access)),
        [status] if status == SIGNED_OUT => Err(SIGNED_OUT),
        _ => Err(UNAVAILABLE),
    }
}

#[tauri::command]
async fn local_revoke(
    window: WebviewWindow,
    plugin: State<'_, LocalProviderPlugin>,
) -> Result<&'static str, &'static str> {
    match call(window, plugin, "revoke").await?.as_slice() {
        [status] if status == "revoked" => Ok("revoked"),
        [status] if status == SIGNED_OUT => Err(SIGNED_OUT),
        _ => Err(UNAVAILABLE),
    }
}

pub(super) fn install(builder: Builder<Wry>) -> Builder<Wry> {
    builder
        .plugin(
            tauri::plugin::Builder::<Wry>::new("local-provider-fixture")
                // Handle direct WebView calls here so Tauri cannot fall back to Kotlin.
                .invoke_handler(|invoke| {
                    invoke.resolver.reject(UNAVAILABLE);
                    true
                })
                .setup(|app, api| {
                    app.manage(LocalProviderPlugin(api.register_android_plugin(
                        "dev.klaxon.p0native",
                        "LocalProviderPlugin",
                    )?));
                    Ok(())
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            local_sign_in,
            local_resume,
            local_access,
            local_revoke,
            crate::android_provider_preflight,
        ])
}
