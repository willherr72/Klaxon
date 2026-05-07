use std::time::Duration;

use crate::error::{AppError, AppResult};
use crate::sync::types::{ChangeSet, PingResponse, PushResponse};

pub struct SyncClient {
    http: reqwest::Client,
    base_url: String,
    secret: String,
}

impl SyncClient {
    /// Build a sync client that pins the peer's cert fingerprint. Without
    /// a fingerprint we refuse to construct one — peers must complete the
    /// pairing handshake first.
    pub fn new(base_url: String, secret: String, cert_fingerprint: &str) -> AppResult<Self> {
        if cert_fingerprint.trim().is_empty() {
            return Err(AppError::Invalid(
                "peer has no pinned cert fingerprint — re-pair the device".into(),
            ));
        }
        let tls_config = crate::sync::tls::pinned_client_config(cert_fingerprint);
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .connect_timeout(Duration::from_secs(5))
            .use_preconfigured_tls((*tls_config).clone())
            .build()
            .map_err(|e| AppError::Invalid(format!("build http client: {e}")))?;
        Ok(Self {
            http,
            base_url: base_url.trim_end_matches('/').to_string(),
            secret,
        })
    }

    pub async fn ping(&self) -> AppResult<PingResponse> {
        let url = format!("{}/klaxon/v1/ping", self.base_url);
        let resp = self
            .http
            .get(&url)
            .bearer_auth(&self.secret)
            .send()
            .await
            .map_err(http_err)?;
        if !resp.status().is_success() {
            return Err(AppError::Invalid(format!(
                "ping {} returned {}",
                url,
                resp.status()
            )));
        }
        resp.json().await.map_err(http_err)
    }

    pub async fn pull(&self, since_ms: i64) -> AppResult<ChangeSet> {
        let url = format!(
            "{}/klaxon/v1/sync/pull?since={}",
            self.base_url, since_ms
        );
        let resp = self
            .http
            .get(&url)
            .bearer_auth(&self.secret)
            .send()
            .await
            .map_err(http_err)?;
        if !resp.status().is_success() {
            return Err(AppError::Invalid(format!(
                "pull returned {}",
                resp.status()
            )));
        }
        resp.json().await.map_err(http_err)
    }

    pub async fn push(&self, set: &ChangeSet) -> AppResult<PushResponse> {
        let url = format!("{}/klaxon/v1/sync/push", self.base_url);
        let resp = self
            .http
            .post(&url)
            .bearer_auth(&self.secret)
            .json(set)
            .send()
            .await
            .map_err(http_err)?;
        if !resp.status().is_success() {
            return Err(AppError::Invalid(format!(
                "push returned {}",
                resp.status()
            )));
        }
        resp.json().await.map_err(http_err)
    }
}

fn http_err(e: reqwest::Error) -> AppError {
    AppError::Invalid(format!("http: {e}"))
}
