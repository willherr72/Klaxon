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
