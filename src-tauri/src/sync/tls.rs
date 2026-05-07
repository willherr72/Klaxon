//! TLS plumbing for sync.
//!
//! Each Klaxon device generates a self-signed cert at first run. The SHA-256
//! fingerprint of the cert is exchanged during pairing and pinned per peer,
//! so subsequent sync calls reject any cert that doesn't match — defeats
//! MITM on the LAN even if attackers can intercept the bytes.

use std::path::Path;
use std::sync::Arc;

use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};

const CERT_FILE: &str = "klaxon-cert.pem";
const KEY_FILE: &str = "klaxon-key.pem";

#[derive(Clone)]
pub struct LocalCert {
    pub cert_pem: String,
    pub key_pem: String,
    pub fingerprint: String,
}

/// Read existing cert/key from `dir` or generate fresh ones if missing.
/// Fingerprint is uppercase-hex SHA-256 of the DER-encoded leaf cert.
pub fn load_or_generate(dir: &Path) -> AppResult<LocalCert> {
    let cert_path = dir.join(CERT_FILE);
    let key_path = dir.join(KEY_FILE);

    if cert_path.exists() && key_path.exists() {
        let cert_pem = std::fs::read_to_string(&cert_path)?;
        let key_pem = std::fs::read_to_string(&key_path)?;
        let fingerprint = fingerprint_from_pem(&cert_pem)?;
        return Ok(LocalCert {
            cert_pem,
            key_pem,
            fingerprint,
        });
    }

    let alt_names = vec!["klaxon.local".to_string(), "localhost".to_string()];
    let generated = rcgen::generate_simple_self_signed(alt_names)
        .map_err(|e| AppError::Invalid(format!("cert generate: {e}")))?;
    let cert_pem = generated.cert.pem();
    let key_pem = generated.key_pair.serialize_pem();
    std::fs::write(&cert_path, &cert_pem)?;
    std::fs::write(&key_path, &key_pem)?;

    let der = generated.cert.der();
    let fingerprint = fingerprint_from_der(der.as_ref());
    log::info!(
        "generated self-signed cert at {} (fp {})",
        cert_path.display(),
        short(&fingerprint)
    );
    Ok(LocalCert {
        cert_pem,
        key_pem,
        fingerprint,
    })
}

fn fingerprint_from_pem(pem: &str) -> AppResult<String> {
    let mut reader = std::io::Cursor::new(pem.as_bytes());
    let der = rustls_pemfile::certs(&mut reader)
        .next()
        .ok_or_else(|| AppError::Invalid("no cert in PEM".into()))?
        .map_err(|e| AppError::Invalid(format!("parse PEM: {e}")))?;
    Ok(fingerprint_from_der(&der))
}

fn fingerprint_from_der(der: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(der);
    hex::encode_upper(hasher.finalize())
}

/// Short prefix of a fingerprint for log lines.
pub fn short(fp: &str) -> String {
    fp.chars().take(12).collect()
}

/// rustls `ClientConfig` that accepts ONLY a cert with the given SHA-256
/// fingerprint. No CA verification — pinning *is* the verification.
pub fn pinned_client_config(expected_fp: &str) -> Arc<rustls::ClientConfig> {
    use rustls::client::danger::{
        HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier,
    };
    use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
    use rustls::{DigitallySignedStruct, SignatureScheme};

    #[derive(Debug)]
    struct PinnedVerifier {
        expected_upper_hex: String,
    }

    impl ServerCertVerifier for PinnedVerifier {
        fn verify_server_cert(
            &self,
            end_entity: &CertificateDer<'_>,
            _intermediates: &[CertificateDer<'_>],
            _server_name: &ServerName<'_>,
            _ocsp_response: &[u8],
            _now: UnixTime,
        ) -> Result<ServerCertVerified, rustls::Error> {
            let actual = fingerprint_from_der(end_entity.as_ref());
            if actual.eq_ignore_ascii_case(&self.expected_upper_hex) {
                Ok(ServerCertVerified::assertion())
            } else {
                Err(rustls::Error::General(format!(
                    "cert fingerprint mismatch — expected {}, got {}",
                    short(&self.expected_upper_hex),
                    short(&actual)
                )))
            }
        }

        fn verify_tls12_signature(
            &self,
            _message: &[u8],
            _cert: &CertificateDer<'_>,
            _dss: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, rustls::Error> {
            Ok(HandshakeSignatureValid::assertion())
        }

        fn verify_tls13_signature(
            &self,
            _message: &[u8],
            _cert: &CertificateDer<'_>,
            _dss: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, rustls::Error> {
            Ok(HandshakeSignatureValid::assertion())
        }

        fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
            vec![
                SignatureScheme::RSA_PSS_SHA256,
                SignatureScheme::RSA_PSS_SHA384,
                SignatureScheme::RSA_PSS_SHA512,
                SignatureScheme::RSA_PKCS1_SHA256,
                SignatureScheme::RSA_PKCS1_SHA384,
                SignatureScheme::RSA_PKCS1_SHA512,
                SignatureScheme::ECDSA_NISTP256_SHA256,
                SignatureScheme::ECDSA_NISTP384_SHA384,
                SignatureScheme::ED25519,
            ]
        }
    }

    let verifier = Arc::new(PinnedVerifier {
        expected_upper_hex: expected_fp.to_uppercase(),
    });
    let config = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
    Arc::new(config)
}
