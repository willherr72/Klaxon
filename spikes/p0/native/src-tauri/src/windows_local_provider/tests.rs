use super::*;
use std::{
    fs,
    sync::atomic::{AtomicU64, Ordering},
    time::SystemTime,
};

const OWNER: &str = "test-owner";
const SUBJECT: &str = "test-session";
const INITIAL: &str = "inert-refresh-initial";
const SUCCESSOR: &str = "inert-refresh-next";
const NULL_ACK: &[u8] = br#"{"status":"success","value":null}"#;
const NO_SESSION: &[u8] = br#"{"status":"success","value":{"kind":"noSession"}}"#;

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let index = NEXT.fetch_add(1, Ordering::Relaxed);
        let nonce = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = env::temp_dir().join(format!(
            "klaxon-p0-local-test-{}-{nonce}-{index}",
            std::process::id()
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> PathBuf {
        self.0.join("packaged.bin")
    }
}

#[test]
fn requires_the_packaged_main_window_origin() {
    let allows = |label, url| crate::is_fixture_origin(label, &tauri::Url::parse(url).unwrap());
    assert!(allows("main", "http://tauri.localhost/index.html"));
    assert!(!allows("peer", "http://tauri.localhost/index.html"));
    for url in [
        "http://127.0.0.1:3210",
        "http://tauri.localhost:3210",
        "https://tauri.localhost",
        "http://tauri.localhost.example",
    ] {
        assert!(!allows("main", url));
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn bearer(subject: Value) -> String {
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256","typ":"JWT"}"#);
    let claims = URL_SAFE_NO_PAD.encode(
        json!({"sub": subject, "aud": "convex-auth", "iat": 1700000000, "exp": 1700000100,
            "iss": "http://127.0.0.1:3210/components/auth"})
        .to_string(),
    );
    let signature = URL_SAFE_NO_PAD.encode(b"inert signature");
    format!("{header}.{claims}.{signature}")
}

fn response(status: Value, owner: &str, subject: Value, refresh: &str) -> Reply {
    let mut value = status;
    value["tokens"] = json!({"accessToken": bearer(subject), "userId": owner,
        "refreshToken": refresh, "refreshTokenExpiresAt": 4102444800000_i64});
    Ok((
        200,
        json!({"status": "success", "value": value, "logLines": []})
            .to_string()
            .into_bytes(),
    ))
}

fn sign_in(provider: &mut Provider, path: &Path) -> Result<&'static str, &'static str> {
    provider.sign_in(path, OWNER, "inert-test-input-a", "inert-test-input-b", |request| {
        assert!(request == &json!({"path":"auth:signInWithUsernamePassword", "format":"convex_encoded_json",
            "args":[{"username":"inert-test-input-a", "password":"inert-test-input-b"}]}));
        response(json!({"status": "complete"}), OWNER, json!(SUBJECT), INITIAL)
    })
}

#[test]
fn confines_the_slot_to_a_disposable_directory() {
    let root = TestDirectory::new();
    let run = "klaxon-p0-session-aB12xZ";
    assert!(slot_path(&root.0, run).is_none());
    fs::create_dir(root.0.join(run)).unwrap();
    assert_eq!(
        slot_path(&root.0, run),
        Some(root.0.join(run).join("packaged.bin"))
    );
    for invalid in [
        "klaxon-p0-session-12345",
        "klaxon-p0-session-1234567",
        "klaxon-p0-session-aB12éZ",
        "klaxon-p0-session-../abc",
        "../klaxon-p0-session-aB12xZ",
    ] {
        assert!(slot_path(&root.0, invalid).is_none());
    }
}

#[test]
fn seeds_rotates_and_revokes_only_the_persisted_target_grant() {
    let dir = TestDirectory::new();
    let path = dir.path();
    let mut first = Provider::default();
    assert_eq!(sign_in(&mut first, &path), Ok("fixture-ready"));
    let ciphertext = fs::read(&path).unwrap();
    for input in [INITIAL, OWNER, SUBJECT, "inert-test-input-b"] {
        assert!(!ciphertext
            .windows(input.len())
            .any(|bytes| bytes == input.as_bytes()));
    }
    assert!(Slot::lock(&path).unwrap().read().is_err());
    assert_eq!(
        first.access(&path, OWNER, false, |_| panic!(
            "cached access made a request"
        )),
        Ok(bearer(json!(SUBJECT)))
    );

    let mut second = Provider::default();
    assert_eq!(
        second.access(&path, OWNER, false, |_| panic!(
            "cold access made a request"
        )),
        Err("signed-out")
    );
    assert_eq!(
        second.resume(&path, OWNER, |request| {
            assert_eq!(request, &refresh_request("auth:refreshSession", INITIAL));
            response(json!({"kind": "rotated"}), OWNER, json!(SUBJECT), SUCCESSOR)
        }),
        Ok("authenticated")
    );
    assert_ne!(fs::read(&path).unwrap(), ciphertext);
    let latest = "inert-refresh-forced";
    assert_eq!(
        second.access(&path, OWNER, true, |request| {
            assert_eq!(request, &refresh_request("auth:refreshSession", SUCCESSOR));
            response(json!({"kind": "rotated"}), OWNER, json!(SUBJECT), latest)
        }),
        Ok(bearer(json!(SUBJECT)))
    );

    let mut calls = [
        ("auth:signOut", NULL_ACK),
        ("auth:refreshSession", NO_SESSION),
    ]
    .into_iter();
    assert_eq!(
        second.revoke(&path, OWNER, |request| {
            let (mutation, reply) = calls.next().expect("unexpected mutation");
            assert_eq!(request, &refresh_request(mutation, latest));
            Ok((200, reply.to_vec()))
        }),
        Ok("revoked")
    );
    assert!(calls.next().is_none());
    assert!(!path.exists());
    assert!(second.active.is_none());
    assert_eq!(
        first.access(&path, OWNER, false, |_| panic!(
            "revoked access made a request"
        )),
        Err("signed-out")
    );
}

#[test]
fn rejects_owner_subject_and_rotation_mismatches_without_writing() {
    let dir = TestDirectory::new();
    let path = dir.path();
    let mut provider = Provider::default();
    for (owner, subject) in [
        ("other-owner", json!(SUBJECT)),
        (OWNER, json!(42)),
        (OWNER, json!(" ")),
    ] {
        assert!(provider
            .sign_in(
                &path,
                OWNER,
                "inert-test-input-a",
                "inert-test-input-b",
                |_| { response(json!({"status": "complete"}), owner, subject, INITIAL) }
            )
            .is_err());
        assert!(!path.exists());
    }
    assert_eq!(sign_in(&mut provider, &path), Ok("fixture-ready"));
    let ciphertext = fs::read(&path).unwrap();
    for (owner, subject, refresh) in [
        ("other-owner", SUBJECT, SUCCESSOR),
        (OWNER, "other-session", SUCCESSOR),
        (OWNER, SUBJECT, INITIAL),
    ] {
        assert!(provider
            .resume(&path, OWNER, |_| {
                response(json!({"kind": "rotated"}), owner, json!(subject), refresh)
            })
            .is_err());
        assert_eq!(fs::read(&path).unwrap(), ciphertext);
        assert!(provider.active.is_none());
    }
}

#[test]
fn pending_revocation_retries_the_same_grant_until_explicit_null() {
    let dir = TestDirectory::new();
    let path = dir.path();
    let mut provider = Provider::default();
    assert_eq!(sign_in(&mut provider, &path), Ok("fixture-ready"));
    let ciphertext = fs::read(&path).unwrap();
    assert_eq!(
        provider.revoke(&path, OWNER, |_| Ok((
            200,
            br#"{"status":"success"}"#.to_vec()
        ))),
        Err("retry-required")
    );
    assert_eq!(fs::read(&path).unwrap(), ciphertext);
    assert_eq!(
        provider.resume(&path, OWNER, |_| panic!("pending revoke refreshed")),
        Err("retry-required")
    );
    let mut calls = [("auth:signOut", NULL_ACK), ("auth:refreshSession", b"{}")].into_iter();
    assert_eq!(
        provider.revoke(&path, OWNER, |request| {
            let (mutation, reply) = calls.next().expect("unexpected mutation");
            assert_eq!(request, &refresh_request(mutation, INITIAL));
            Ok((200, reply.to_vec()))
        }),
        Err("retry-required")
    );
    assert!(calls.next().is_none());
    assert_eq!(fs::read(&path).unwrap(), ciphertext);
    let mut calls = [
        ("auth:signOut", NULL_ACK),
        ("auth:refreshSession", NO_SESSION),
    ]
    .into_iter();
    assert_eq!(
        provider.revoke(&path, OWNER, |request| {
            let (mutation, reply) = calls.next().expect("unexpected mutation");
            assert_eq!(request, &refresh_request(mutation, INITIAL));
            Ok((200, reply.to_vec()))
        }),
        Ok("revoked")
    );
    assert!(calls.next().is_none());
}
