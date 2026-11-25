use super::sign_out::run as sign_out;
use super::*;
use std::{
    fs,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const CHILD_TEST: &str = "windows_session::tests::refresh_child";
const TEST_PATH: &str = "KLAXON_P0_TEST_SLOT";
const TEST_ACTION: &str = "KLAXON_P0_TEST_ACTION";
const TEST_CHECKPOINT: &str = "KLAXON_P0_TEST_CHECKPOINT";

fn seed(slot: &Path, marker: &[u8]) -> io::Result<()> {
    store::Slot::lock(slot)?.publish(marker, store::Publish::Seed)
}

struct TestSlot {
    path: PathBuf,
}

impl TestSlot {
    fn new(label: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory =
            env::temp_dir().join(format!("klaxon-p0-{label}-{}-{nonce}", std::process::id()));
        fs::create_dir(&directory).unwrap();
        Self {
            path: directory.join("packaged.bin"),
        }
    }

    fn flag(&self, name: &str, enabled: bool) {
        let path = self.path.with_file_name(name);
        if enabled {
            fs::File::create_new(path).unwrap();
        } else {
            fs::remove_file(path).unwrap();
        }
    }

    fn ciphertext(&self) -> Vec<u8> {
        fs::read(&self.path).unwrap()
    }

    fn staged(&self) -> PathBuf {
        self.path.with_extension("staged")
    }

    fn child(&self, action: &str, checkpoint: &str) -> TestChild {
        let child = Command::new(env::current_exe().unwrap())
            .args(["--exact", CHILD_TEST, "--ignored", "--nocapture"])
            .env(TEST_PATH, &self.path)
            .env(TEST_ACTION, action)
            .env(TEST_CHECKPOINT, checkpoint)
            .stdin(Stdio::null())
            .spawn()
            .unwrap();
        assert_ne!(child.id(), std::process::id());
        TestChild(child)
    }
}

impl Drop for TestSlot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(self.path.parent().unwrap());
    }
}

struct TestChild(Child);

impl TestChild {
    fn wait_for_checkpoint(&mut self, slot: &TestSlot) {
        let ready = slot.path.with_extension("checkpoint");
        let deadline = Instant::now() + Duration::from_secs(20);
        while !ready.try_exists().unwrap() {
            assert!(
                self.0.try_wait().unwrap().is_none(),
                "child exited before checkpoint"
            );
            assert!(Instant::now() < deadline, "child did not reach checkpoint");
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn terminate(&mut self) {
        assert!(self.0.try_wait().unwrap().is_none());
        self.0.kill().unwrap();
        assert!(
            !self.0.wait().unwrap().success(),
            "child acknowledged before termination"
        );
    }

    fn expect_success(mut self) {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            if let Some(status) = self.0.try_wait().unwrap() {
                assert!(status.success(), "fresh fixture child failed");
                return;
            }
            assert!(Instant::now() < deadline, "fresh fixture child timed out");
            thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for TestChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

pub(super) fn crash_checkpoint(path: &Path, checkpoint: &str) {
    if env::var_os(TEST_PATH).as_deref() == Some(path.as_os_str())
        && env::var(TEST_CHECKPOINT).as_deref() == Ok(checkpoint)
    {
        fs::File::create_new(path.with_extension("checkpoint")).unwrap();
        loop {
            thread::park();
        }
    }
}

#[test]
#[ignore = "run only as a child by the DPAPI recovery tests"]
fn refresh_child() {
    let path = PathBuf::from(env::var_os(TEST_PATH).expect("test child slot"));
    match env::var(TEST_ACTION).as_deref() {
        Ok("resume") => {
            let session = confirm_session(&path, None).unwrap();
            assert!(session.owner == Owner::A);
            let mut provider = Provider::new();
            provider.owner = Some(session.owner);
            assert!(provider.sdk_access(Some(&path)).unwrap() == "p0-inert-access-a");
        }
        Ok("sign-out") => assert_eq!(sign_out(&path), Ok("signed-out")),
        Ok("retry-sign-out") => assert_eq!(sign_out(&path), Err("retry-required")),
        Ok("sign-out-pending") => {
            let mut provider = Provider::new();
            assert!(provider.sdk_access(Some(&path)).is_err());
            assert_eq!(confirm_session(&path, None).err(), Some("retry-required"));
            for owner in [Owner::A, Owner::B] {
                assert_eq!(seed_session(&path, owner), Err("retry-required"));
            }
            assert!(provider.sdk_access(Some(&path)).is_err());
        }
        _ => panic!("invalid fixture child action"),
    }
}

#[test]
fn interrupted_before_replace_preserves_predecessor_and_retries() {
    let slot = TestSlot::new("pre-replace");
    seed(&slot.path, MARKER).unwrap();
    let predecessor = slot.ciphertext();
    slot.flag("p0-provider-refresh", true);
    let unrelated = slot.path.with_file_name("unrelated.staged");
    fs::write(&unrelated, b"unrelated fixture file").unwrap();

    let mut writer = slot.child("resume", "before-replace");
    writer.wait_for_checkpoint(&slot);
    let staged = fs::read(slot.staged()).unwrap();
    assert!(!staged.is_empty(), "the process paused before staging");
    assert!(
        !staged
            .windows(SUCCESSOR_MARKER.len())
            .any(|bytes| bytes == SUCCESSOR_MARKER),
        "the staged record contains plaintext"
    );
    assert!(slot.ciphertext() == predecessor);
    assert!(
        seed(&slot.path, PEER_MARKER).is_err(),
        "concurrent seed acquired the slot"
    );
    assert_eq!(sign_out(&slot.path), Err("unavailable"));
    assert!(
        confirm_session(&slot.path, None).is_err(),
        "concurrent resume acquired the slot"
    );
    assert!(
        slot.staged().try_exists().unwrap(),
        "a competing worker removed live staging"
    );
    writer.terminate();

    assert!(
        slot.ciphertext() == predecessor,
        "termination rewrote the predecessor"
    );
    assert!(
        slot.staged().try_exists().unwrap(),
        "test failed to leave staged ciphertext"
    );
    slot.flag("p0-provider-refresh", false);
    slot.child("resume", "").expect_success();
    assert!(slot.ciphertext() == predecessor);
    assert!(
        !slot.staged().try_exists().unwrap(),
        "cold resume left orphan staging"
    );
    slot.flag("p0-provider-refresh", true);
    slot.child("resume", "").expect_success();
    assert!(
        slot.ciphertext() != predecessor,
        "retry did not publish a successor"
    );
    assert!(!slot.staged().try_exists().unwrap());
    assert!(
        unrelated.try_exists().unwrap(),
        "recovery removed an unrelated file"
    );
}

#[test]
fn interrupted_after_replace_resumes_successor_before_acknowledgment() {
    let slot = TestSlot::new("post-replace");
    seed(&slot.path, MARKER).unwrap();
    let predecessor = slot.ciphertext();
    slot.flag("p0-provider-refresh", true);

    let mut writer = slot.child("resume", "after-replace");
    writer.wait_for_checkpoint(&slot);
    let successor = slot.ciphertext();
    assert!(
        successor != predecessor,
        "the process paused before publishing"
    );
    assert!(!slot.staged().try_exists().unwrap());
    writer.terminate();

    slot.flag("p0-require-successor", true);
    slot.child("resume", "").expect_success();
    assert!(
        slot.ciphertext() == successor,
        "cold resume replaced the successor again"
    );
    assert!(!slot.staged().try_exists().unwrap());
    assert!(!slot.path.with_extension("lock").try_exists().unwrap());
}

#[test]
fn sign_out_after_interruption_removes_only_scoped_files() {
    let slot = TestSlot::new("interrupted-sign-out");
    seed(&slot.path, MARKER).unwrap();
    slot.flag("p0-provider-refresh", true);
    let unrelated = slot.path.with_file_name("other-session.bin");
    fs::write(&unrelated, b"unrelated fixture file").unwrap();

    let mut writer = slot.child("resume", "before-replace");
    writer.wait_for_checkpoint(&slot);
    writer.terminate();
    assert!(slot.staged().try_exists().unwrap());

    slot.child("sign-out", "").expect_success();
    assert!(!slot.staged().try_exists().unwrap());
    assert!(!slot.path.try_exists().unwrap());
    assert_eq!(confirm_session(&slot.path, None).err(), Some("signed-out"));
    assert!(unrelated.try_exists().unwrap());
    seed(&slot.path, PEER_MARKER).unwrap();
    let peer = slot.ciphertext();
    let session = confirm_session(&slot.path, None).unwrap();
    assert!(session.owner == Owner::B && session.access == "p0-inert-access-b");
    assert!(
        slot.ciphertext() == peer,
        "the A refresh flag rewrote the peer record"
    );
}

#[test]
fn native_task_peer_drops_its_subscription_after_another_process_starts_sign_out() {
    let slot = TestSlot::new("peer-task-revocation");
    seed(&slot.path, SUCCESSOR_MARKER).unwrap();
    let mut peer = Provider::new();
    peer.owner = Some(confirm_session(&slot.path, None).unwrap().owner);
    let path = Some(slot.path.as_path());
    peer.active_tasks(path).unwrap().subscription = Some(Channel::new(|_| Ok(())));
    assert_eq!(peer.active_tasks(path).unwrap().rows().unwrap().len(), 1);
    slot.flag("p0-signout-drop-reply", true);
    slot.child("retry-sign-out", "").expect_success();
    assert_eq!(peer.active_tasks(path).err(), Some("retry-required"));
    assert!(peer.owner.is_none() && peer.subscription.is_none());
    assert_eq!(peer.publish(), Err("signed-out"));
}

#[test]
fn offline_sign_out_blocks_cold_access_before_the_provider_commits() {
    let slot = TestSlot::new("offline-sign-out");
    seed(&slot.path, SUCCESSOR_MARKER).unwrap();
    let ciphertext = slot.ciphertext();
    let receipt = slot.path.with_file_name("p0-issuer-revoked-successor");
    let pending = slot.path.with_extension("signout-pending");
    let mut provider = Provider::new();
    provider.owner = Some(confirm_session(&slot.path, None).unwrap().owner);
    slot.flag("p0-provider-offline", true);
    slot.flag("p0-signout-drop-reply", true);
    slot.child("retry-sign-out", "").expect_success();

    assert!(pending.is_file());
    assert!(!receipt.exists());
    assert!(slot.ciphertext() == ciphertext);
    slot.flag("p0-provider-offline", false);
    slot.child("sign-out-pending", "").expect_success();
    assert_eq!(
        provider.sdk_access(Some(&slot.path)).err(),
        Some("retry-required")
    );
    assert!(provider.owner.is_none());
    assert!(!receipt.exists(), "resume committed a pending sign-out");
}

#[test]
fn lost_sign_out_reply_retries_the_rotated_marker_before_clearing() {
    let slot = TestSlot::new("lost-sign-out");
    seed(&slot.path, MARKER).unwrap();
    slot.flag("p0-provider-refresh", true);
    slot.child("resume", "").expect_success();
    slot.flag("p0-provider-refresh", false);
    let successor = slot.ciphertext();
    let receipt = slot.path.with_file_name("p0-issuer-revoked-successor");
    let pending = slot.path.with_extension("signout-pending");
    slot.flag("p0-signout-expect-successor", true);
    slot.flag("p0-signout-drop-reply", true);
    slot.child("retry-sign-out", "").expect_success();

    assert!(slot.ciphertext() == successor);
    assert!(pending.is_file());
    assert!(fs::read(&receipt).unwrap().is_empty());
    slot.flag("p0-signout-drop-reply", false);
    fs::remove_file(&slot.path).unwrap();
    slot.child("retry-sign-out", "").expect_success();
    assert_eq!(fs::read(&pending).unwrap(), b"pending");
    assert!(!slot
        .path
        .with_file_name("p0-issuer-acknowledged-successor")
        .exists());
    fs::write(&slot.path, &successor).unwrap();
    slot.child("sign-out-pending", "").expect_success();

    {
        let store = store::Slot::lock(&slot.path).unwrap();
        store.publish(MARKER, store::Publish::Refresh).unwrap();
    }
    slot.child("retry-sign-out", "").expect_success();
    assert!(pending.is_file() && slot.path.is_file());
    fs::write(&slot.path, successor).unwrap();
    // A broken observer cannot prevent an otherwise valid issuer acknowledgment.
    fs::create_dir(slot.path.with_file_name("p0-issuer-acknowledged-successor")).unwrap();
    slot.child("sign-out", "").expect_success();

    assert!(!pending.exists() && !slot.path.exists() && !slot.staged().exists());
    assert!(receipt.is_file());
    slot.flag("p0-signout-expect-successor", false);
    assert_eq!(confirm_session(&slot.path, None).err(), Some("signed-out"));
    assert_eq!(seed_session(&slot.path, Owner::A), Ok("fixture-ready"));
    assert!(confirm_session(&slot.path, None).is_ok());
    assert_eq!(sign_out(&slot.path), Ok("signed-out"));
    assert_eq!(seed_session(&slot.path, Owner::B), Ok("fixture-ready"));
    assert!(confirm_session(&slot.path, None).unwrap().owner == Owner::B);
}

#[test]
fn cold_retry_finishes_acknowledged_sign_out_after_record_deletion() {
    let slot = TestSlot::new("partial-sign-out");
    seed(&slot.path, SUCCESSOR_MARKER).unwrap();
    let pending = slot.path.with_extension("signout-pending");
    let mut writer = slot.child("sign-out", "after-sign-out-remove");
    writer.wait_for_checkpoint(&slot);
    assert!(!slot.path.exists());
    assert_eq!(fs::read(&pending).unwrap(), b"acknowledged");
    assert_eq!(sign_out(&slot.path), Err("unavailable"));
    assert_eq!(seed_session(&slot.path, Owner::B), Err("unavailable"));
    writer.terminate();

    slot.flag("p0-provider-offline", true);
    slot.child("sign-out-pending", "").expect_success();
    slot.child("sign-out", "").expect_success();
    assert!(!pending.exists() && !slot.staged().exists());
    assert_eq!(seed_session(&slot.path, Owner::B), Ok("fixture-ready"));
}

#[test]
fn sign_out_intent_survives_an_unreadable_record() {
    let slot = TestSlot::new("unreadable-sign-out");
    seed(&slot.path, MARKER).unwrap();
    let original = slot.ciphertext();
    fs::write(&slot.path, b"unreadable fixture").unwrap();
    assert_eq!(sign_out(&slot.path), Err("retry-required"));
    fs::write(&slot.path, original).unwrap();
    assert_eq!(
        confirm_session(&slot.path, None).err(),
        Some("retry-required")
    );
    assert_eq!(sign_out(&slot.path), Ok("signed-out"));
}

#[test]
fn missing_record_keeps_unacknowledged_sign_out_pending() {
    let slot = TestSlot::new("missing-sign-out-record");
    assert_eq!(sign_out(&slot.path), Ok("signed-out"));
    seed(&slot.path, MARKER).unwrap();
    let ciphertext = slot.ciphertext();
    slot.flag("p0-provider-offline", true);
    assert_eq!(sign_out(&slot.path), Err("retry-required"));
    fs::remove_file(&slot.path).unwrap();
    slot.flag("p0-provider-offline", false);

    slot.child("sign-out-pending", "").expect_success();
    slot.child("retry-sign-out", "").expect_success();
    fs::write(&slot.path, ciphertext).unwrap();
    slot.child("sign-out", "").expect_success();
    assert_eq!(confirm_session(&slot.path, None).err(), Some("signed-out"));
}

#[test]
fn only_success_with_an_explicit_null_acknowledges_sign_out() {
    let slot = TestSlot::new("invalid-sign-out-reply");
    seed(&slot.path, MARKER).unwrap();
    let ciphertext = slot.ciphertext();
    let pending = slot.path.with_extension("signout-pending");
    slot.flag("p0-provider-offline", true);
    assert_eq!(sign_out(&slot.path), Err("retry-required"));
    let locked = store::Slot::lock(&slot.path).unwrap();
    let success = br#"{"status":"success","value":null,"logLines":[]}"#;
    let cases: &[(u16, &[u8])] = &[
        (200, b"{"),
        (200, b"null"),
        (200, br#"["success",null,[]]"#),
        (200, br#"{"status":"success"}"#),
        (200, br#"{"status":"success","value":{}}"#),
        (200, br#"{"status":"success","value":null,"value":false}"#),
        (200, br#"{"status":"success","value":null} null"#),
        (
            200,
            br#"{"status":"error","errorMessage":"fixture rejection","logLines":[]}"#,
        ),
        (200, br#"{"status":"error","value":null}"#),
        (
            200,
            br#"{"status":"success","errorMessage":"fixture rejection","value":null}"#,
        ),
        (301, success),
        (401, success),
        (500, success),
        (560, success),
    ];
    for (index, &(status, body)) in cases.iter().enumerate() {
        assert_eq!(
            sign_out::accept(&locked, status, body),
            Err("retry-required"),
            "accepted invalid response {index}"
        );
        assert!(slot.ciphertext() == ciphertext && pending.is_file());
    }
    assert_eq!(sign_out::accept(&locked, 200, success), Ok("signed-out"));
    assert!(!slot.path.exists() && !pending.exists());
}

#[test]
fn sign_out_over_loopback_requires_explicit_null_and_retries_the_same_marker() {
    let slot = TestSlot::new("http-sign-out");
    seed(&slot.path, SUCCESSOR_MARKER).unwrap();
    let ciphertext = slot.ciphertext();
    let pending = slot.path.with_extension("signout-pending");
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let attempt = |reply| {
        sign_out::run_with_provider(&slot.path, |request| {
            assert_eq!(
                fs::read(&pending).unwrap(),
                b"pending",
                "record intent before sending"
            );
            runtime.block_on(async {
                tokio::time::timeout(Duration::from_secs(5), loopback_sign_out(request, reply))
                    .await
                    .expect("sign-out exchange timed out")
            })
        })
    };

    let success: &[u8] = br#"{"status":"success","value":null,"logLines":[]}"#;
    for (label, reply) in [
        ("lost reply", None),
        ("malformed JSON", Some((200, &b"{"[..]))),
        (
            "missing explicit null",
            Some((200, &br#"{"status":"success","logLines":[]}"#[..])),
        ),
        ("HTTP error with a success envelope", Some((503, success))),
    ] {
        assert_eq!(attempt(reply), Err("retry-required"), "{label}");
        assert!(
            slot.ciphertext() == ciphertext,
            "{label} changed ciphertext"
        );
        assert_eq!(fs::read(&pending).unwrap(), b"pending", "{label}");
        assert_eq!(
            confirm_session(&slot.path, None).err(),
            Some("retry-required")
        );
    }

    assert_eq!(attempt(Some((200, success))), Ok("signed-out"));
    assert!(!slot.path.exists() && !pending.exists());
    assert_eq!(confirm_session(&slot.path, None).err(), Some("signed-out"));
}

async fn loopback_sign_out(
    request: &serde_json::Value,
    reply: Option<(u16, &'static [u8])>,
) -> Result<(u16, hyper::body::Bytes), &'static str> {
    use http_body_util::{BodyExt, Full};
    use hyper::{
        body::{Bytes, Incoming},
        header::CONTENT_TYPE,
        server::conn::http1,
        service::service_fn,
        Method, Request, Response,
    };
    use hyper_util::rt::TokioIo;
    use std::sync::atomic::{AtomicBool, Ordering};
    use tokio::net::TcpListener;

    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let checked = AtomicBool::new(false);
        let (stream, _) = listener.accept().await.unwrap();
        let service = service_fn(|request: Request<Incoming>| async {
            let (parts, body) = request.into_parts();
            assert!(parts.method == Method::POST, "expected POST");
            assert!(
                parts
                    .uri
                    .path_and_query()
                    .is_some_and(|uri| uri.as_str() == "/api/mutation"),
                "unexpected mutation target"
            );
            assert!(
                parts
                    .headers
                    .get(CONTENT_TYPE)
                    .is_some_and(|value| value == "application/json"),
                "expected JSON content type"
            );
            let body = body
                .collect()
                .await
                .expect("unreadable request body")
                .to_bytes();
            let expected = serde_json::json!({
                "path": "auth:signOut",
                "format": "convex_encoded_json",
                "args": [{ "refreshToken": std::str::from_utf8(SUCCESSOR_MARKER).unwrap() }]
            });
            assert!(
                body.as_ref() == serde_json::to_vec(&expected).unwrap(),
                "unexpected mutation body"
            );
            checked.store(true, Ordering::Relaxed);
            let (status, body) =
                reply.ok_or_else(|| io::Error::other("fixture dropped its reply"))?;
            Ok::<_, io::Error>(
                Response::builder()
                    .status(status)
                    .body(Full::new(Bytes::from_static(body)))
                    .unwrap(),
            )
        });
        let served = http1::Builder::new()
            .keep_alive(false)
            .serve_connection(TokioIo::new(stream), service)
            .await;
        assert!(
            checked.load(Ordering::Relaxed),
            "fixture did not validate a request"
        );
        assert_eq!(served.is_err(), reply.is_none());
    });
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .build()
        .unwrap();
    let received = client
        .post(format!("http://{address}/api/mutation"))
        .json(request)
        .send()
        .await;
    server.await.expect("loopback fixture failed");
    assert_eq!(
        received.is_err(),
        reply.is_none(),
        "unexpected HTTP outcome"
    );
    match received {
        Ok(response) => {
            let status = response.status().as_u16();
            Ok((status, response.bytes().await.expect("unreadable reply")))
        }
        Err(_) => Err("retry-required"),
    }
}

#[test]
fn initial_grant_must_publish_without_overwriting_an_existing_owner() {
    let slot = TestSlot::new("initial-grant");
    // The test removes the synced stage so the actual atomic publication must fail.
    slot.flag("discard-initial-stage", true);
    assert_eq!(seed_session(&slot.path, Owner::A), Err("unavailable"));
    assert!(!slot.path.exists() && !slot.staged().exists());
    slot.flag("discard-initial-stage", false);

    assert_eq!(seed_session(&slot.path, Owner::B), Ok("fixture-ready"));
    let peer = slot.ciphertext();
    for flag in ["p0-signin-denied", "p0-signin-owner-mismatch"] {
        slot.flag(flag, true);
        assert_eq!(seed_session(&slot.path, Owner::A), Err("unavailable"));
        slot.flag(flag, false);
        assert!(
            slot.ciphertext() == peer,
            "denial changed an existing session"
        );
    }
    assert_eq!(seed_session(&slot.path, Owner::A), Err("unavailable"));
    assert!(slot.ciphertext() == peer && !slot.staged().exists());
    assert!(confirm_session(&slot.path, None).unwrap().owner == Owner::B);
}

#[test]
fn sdk_access_publishes_the_grant_only_when_provider_is_available() {
    let slot = TestSlot::new("sdk-refresh");
    seed(&slot.path, MARKER).unwrap();
    let predecessor = slot.ciphertext();
    let path = Some(slot.path.as_path());
    let mut provider = Provider::new();
    provider.owner = Some(confirm_session(&slot.path, None).unwrap().owner);
    slot.flag("p0-provider-refresh", true);
    slot.flag("p0-provider-offline", true);

    assert_eq!(provider.sdk_access(path).err(), Some("retry-required"));
    assert!(provider.owner.is_none());
    assert!(slot.ciphertext() == predecessor);
    slot.flag("p0-provider-refresh", false);
    slot.flag("p0-provider-offline", false);
    provider.owner = Some(confirm_session(&slot.path, None).unwrap().owner);
    slot.flag("p0-provider-refresh", true);

    assert!(provider.sdk_access(path).unwrap() == "p0-inert-access-a");
    assert!(slot.ciphertext() != predecessor);
    slot.flag("p0-require-successor", true);
    assert!(confirm_session(&slot.path, None).is_ok());
}

#[test]
fn only_a_confirmed_no_session_removes_the_record() {
    let test = TestSlot::new("no-session");
    seed(&test.path, MARKER).unwrap();
    let before = test.ciphertext();
    let slot = store::Slot::lock(&test.path).unwrap();
    let failed = br#"{"status":"error","value":{"kind":"noSession"}}"#;
    assert_eq!(accept_refresh(&slot, failed).err(), Some("unavailable"));
    assert!(test.ciphertext() == before);

    let ended = br#"{"status":"success","value":{"kind":"noSession"}}"#;
    assert_eq!(accept_refresh(&slot, ended).err(), Some("signed-out"));
    drop(slot);
    assert!(!test.path.try_exists().unwrap());
    assert_eq!(confirm_session(&test.path, None).err(), Some("signed-out"));
}

#[test]
fn invalid_grant_cannot_change_the_record() {
    let test = TestSlot::new("invalid-grant");
    seed(&test.path, MARKER).unwrap();
    let predecessor = test.ciphertext();
    let slot = store::Slot::lock(&test.path).unwrap();
    let response = std::str::from_utf8(REFRESH_RESPONSE).unwrap();
    for (label, field, replacement) in [
        ("foreign owner", OWNER_A_ID, "p0-fixture-owner-b"),
        ("peer access", OWNER_A_ACCESS, "p0-inert-access-b"),
        ("peer marker", "packaged/3", "packaged/2"),
        ("predecessor marker", "packaged/3", "packaged/1"),
    ] {
        let body = response.replace(field, replacement);
        assert!(body != response);
        assert_eq!(
            accept_refresh(&slot, body.as_bytes()).err(),
            Some("unavailable"),
            "{label}"
        );
        assert!(
            test.ciphertext() == predecessor,
            "{label} changed the record"
        );
        assert!(!test.staged().try_exists().unwrap());
    }
}

#[test]
fn requiring_successor_denies_predecessor_without_rotating() {
    let slot = TestSlot::new("successor-verifier");
    seed(&slot.path, MARKER).unwrap();
    slot.flag("p0-require-successor", true);
    slot.flag("p0-provider-refresh", true);

    assert_eq!(confirm_session(&slot.path, None).err(), Some("signed-out"));
    assert!(!slot.path.try_exists().unwrap());
}

#[test]
fn sdk_access_rechecks_record_and_revokes_on_failure() {
    let mut provider = Provider::new();
    let slot = TestSlot::new("sdk-recheck");
    let path = Some(slot.path.as_path());

    seed(&slot.path, MARKER).unwrap();
    assert_eq!(provider.sdk_access(path).err(), Some("signed-out"));
    provider.owner = Some(confirm_session(&slot.path, None).unwrap().owner);
    let expected = "p0-inert-access-a";
    assert!(provider.sdk_access(path).unwrap() == expected);
    slot.flag("p0-provider-rotated", true);
    let rotated_access = provider.sdk_access(path);

    slot.flag("p0-provider-offline", true);
    assert_eq!(provider.sdk_access(path).err(), Some("retry-required"));
    slot.flag("p0-provider-offline", false);
    assert_eq!(provider.sdk_access(path).err(), Some("signed-out"));

    provider.owner = Some(confirm_session(&slot.path, None).unwrap().owner);
    assert_eq!(sign_out(&slot.path), Ok("signed-out"));
    seed(&slot.path, PEER_MARKER).unwrap();
    assert_eq!(provider.sdk_access(path).err(), Some("unavailable"));
    assert!(provider.owner.is_none());
    provider.owner = Some(confirm_session(&slot.path, None).unwrap().owner);
    let expected = "p0-inert-access-b";
    assert!(provider.sdk_access(path).unwrap() == expected);

    fs::write(&slot.path, b"damaged").unwrap();
    assert_eq!(provider.sdk_access(path).err(), Some("unavailable"));
    assert!(provider.owner.is_none());
    let expected = concat!(
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.",
        "eyJzdWIiOiJwMC1pbmVydC1hY2Nlc3MtYTIiLCJpYXQiOjE3MDAwMDAwMDAsImV4cCI6MTcwMDA4NjQwMH0.",
        "cDAtbm90LWEtc2lnbmF0dXJl"
    );
    assert!(rotated_access.is_ok_and(|access| access == expected));
}
