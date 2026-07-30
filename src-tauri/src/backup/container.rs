//! The `.klaxonbak` container: header (magic, version, Argon2 salt +
//! params, GCM nonce) followed by AES-256-GCM ciphertext of a postcard
//! `BackupPayload`. The payload includes the iroh secret key, which can
//! impersonate this device on the sync mesh — hence encryption is not
//! optional. See spec §4.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

const MAGIC: &[u8; 6] = b"KLXBAK";
const CONTAINER_VERSION: u16 = 1;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;

// Argon2id parameters, recorded in the header so future builds can
// verify old files even if defaults change. 64 MiB, 3 passes, 4 lanes —
// interactive-use tier, ~200ms on desktop, acceptable on phone.
const ARGON_M_KIB: u32 = 64 * 1024;
const ARGON_T: u32 = 3;
const ARGON_P: u32 = 4;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupManifest {
    pub schema_version: i64,
    pub app_version: String,
    pub device_name: String,
    pub created_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupPayload {
    pub manifest: BackupManifest,
    pub db: Vec<u8>,
    pub iroh_secret: Vec<u8>,
}

fn derive_key(passphrase: &str, salt: &[u8], m: u32, t: u32, p: u32) -> AppResult<[u8; 32]> {
    let params = Params::new(m, t, p, Some(32))
        .map_err(|e| AppError::Invalid(format!("argon2 params: {e}")))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = [0u8; 32];
    argon
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|e| AppError::Invalid(format!("argon2: {e}")))?;
    Ok(key)
}

pub fn seal(payload: &BackupPayload, passphrase: &str) -> AppResult<Vec<u8>> {
    use rand::RngCore;
    let mut salt = [0u8; SALT_LEN];
    let mut nonce = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut salt);
    rand::thread_rng().fill_bytes(&mut nonce);

    let key = derive_key(passphrase, &salt, ARGON_M_KIB, ARGON_T, ARGON_P)?;
    let plain = postcard::to_allocvec(payload)
        .map_err(|e| AppError::Invalid(format!("encode payload: {e}")))?;
    let cipher = Aes256Gcm::new((&key).into())
        .encrypt(Nonce::from_slice(&nonce), plain.as_slice())
        .map_err(|_| AppError::Invalid("encryption failed".into()))?;

    let mut out = Vec::with_capacity(6 + 2 + SALT_LEN + 12 + NONCE_LEN + cipher.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&CONTAINER_VERSION.to_be_bytes());
    out.extend_from_slice(&salt);
    out.extend_from_slice(&ARGON_M_KIB.to_be_bytes());
    out.extend_from_slice(&ARGON_T.to_be_bytes());
    out.extend_from_slice(&ARGON_P.to_be_bytes());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&cipher);
    Ok(out)
}

pub fn unseal(bytes: &[u8], passphrase: &str) -> AppResult<BackupPayload> {
    const HEADER: usize = 6 + 2 + SALT_LEN + 12 + NONCE_LEN;
    if bytes.len() < HEADER {
        return Err(AppError::Invalid("not a Klaxon backup (too short)".into()));
    }
    if &bytes[..6] != MAGIC {
        return Err(AppError::Invalid("not a Klaxon backup".into()));
    }
    let version = u16::from_be_bytes([bytes[6], bytes[7]]);
    if version > CONTAINER_VERSION {
        return Err(AppError::Invalid(format!(
            "this backup came from a newer Klaxon (container v{version})"
        )));
    }
    let mut off = 8;
    let salt = &bytes[off..off + SALT_LEN];
    off += SALT_LEN;
    let m = u32::from_be_bytes(bytes[off..off + 4].try_into().unwrap());
    let t = u32::from_be_bytes(bytes[off + 4..off + 8].try_into().unwrap());
    let p = u32::from_be_bytes(bytes[off + 8..off + 12].try_into().unwrap());
    off += 12;
    let nonce = &bytes[off..off + NONCE_LEN];
    off += NONCE_LEN;

    let key = derive_key(passphrase, salt, m, t, p)?;
    let plain = Aes256Gcm::new((&key).into())
        .decrypt(Nonce::from_slice(nonce), &bytes[off..])
        .map_err(|_| {
            AppError::Invalid("wrong passphrase, or the file is damaged".into())
        })?;
    postcard::from_bytes(&plain)
        .map_err(|e| AppError::Invalid(format!("decode payload: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload() -> BackupPayload {
        BackupPayload {
            manifest: BackupManifest {
                schema_version: 10,
                app_version: "0.5.1".into(),
                device_name: "TestBox".into(),
                created_ms: 1_234,
            },
            db: vec![1, 2, 3, 4, 5],
            iroh_secret: vec![9; 32],
        }
    }

    #[test]
    fn seal_unseal_roundtrips() {
        let sealed = seal(&payload(), "correct horse").unwrap();
        assert_eq!(&sealed[..6], b"KLXBAK");
        let back = unseal(&sealed, "correct horse").unwrap();
        assert_eq!(back.db, vec![1, 2, 3, 4, 5]);
        assert_eq!(back.iroh_secret, vec![9; 32]);
        assert_eq!(back.manifest.device_name, "TestBox");
    }

    #[test]
    fn wrong_passphrase_fails_cleanly() {
        let sealed = seal(&payload(), "correct horse").unwrap();
        let err = unseal(&sealed, "battery staple");
        assert!(err.is_err(), "wrong passphrase must not decrypt");
    }

    #[test]
    fn a_flipped_bit_is_detected() {
        let mut sealed = seal(&payload(), "pw").unwrap();
        let last = sealed.len() - 1;
        sealed[last] ^= 0x01;
        assert!(unseal(&sealed, "pw").is_err(), "GCM must reject tampering");
    }

    #[test]
    fn wrong_magic_and_future_version_are_refused() {
        let mut sealed = seal(&payload(), "pw").unwrap();
        sealed[0] = b'X';
        assert!(unseal(&sealed, "pw").is_err(), "bad magic");

        let mut sealed = seal(&payload(), "pw").unwrap();
        // version is the u16 right after the 6-byte magic
        sealed[6] = 0xFF;
        sealed[7] = 0xFF;
        assert!(unseal(&sealed, "pw").is_err(), "future container version");
    }
}
