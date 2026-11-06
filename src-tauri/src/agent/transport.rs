use super::{AgentState, Client, Session};
use crate::error::{AppError, AppResult};
use rmcp::ServiceExt;
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub(super) fn private_write(path: &Path, bytes: &[u8]) -> AppResult<()> {
    use std::io::Write;
    let pending = path.with_extension("pending");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&pending)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(pending, path)?;
    Ok(())
}
#[derive(Serialize, Deserialize)]
struct Auth {
    id: String,
    token: String,
}
async fn authenticate<S: AsyncRead + Unpin>(stream: &mut S) -> AppResult<Auth> {
    let mut bytes = vec![];
    for _ in 0..512 {
        let b = stream.read_u8().await?;
        if b == b'\n' {
            return Ok(serde_json::from_slice(&bytes)?);
        }
        bytes.push(b);
    }
    Err(AppError::Invalid("Invalid authentication frame".into()))
}
async fn serve<S: AsyncRead + AsyncWrite + Unpin + Send + 'static>(
    mut stream: S,
    app: AppHandle,
) -> AppResult<()> {
    let auth = tokio::time::timeout(Duration::from_secs(5), authenticate(&mut stream))
        .await
        .map_err(|_| AppError::Invalid("Authentication timed out".into()))??;
    let valid = app
        .state::<AgentState>()
        .clients
        .lock()
        .iter()
        .any(|c| c.id == auth.id && c.token == auth.token);
    if !valid {
        return Err(AppError::Invalid("Agent access denied".into()));
    }
    stream.write_all(b"\n").await?;
    let (read, write) = tokio::io::split(stream);
    let transport = rmcp::transport::async_rw::AsyncRwTransport::new(read, write)
        .with_max_line_length(64 * 1024);
    let service = tokio::time::timeout(
        Duration::from_secs(15),
        Session {
            app,
            client_id: auth.id,
        }
        .serve(transport),
    )
    .await
    .map_err(|_| AppError::Invalid("MCP initialization timed out".into()))?
    .map_err(|_| AppError::Invalid("MCP initialization failed".into()))?;
    let _ = service.waiting().await;
    Ok(())
}
pub fn start(app: AppHandle, directory: PathBuf) -> AppResult<()> {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = listen(app, directory).await {
            log::error!("Agent listener stopped: {e}");
        }
    });
    Ok(())
}
async fn listen(app: AppHandle, directory: PathBuf) -> AppResult<()> {
    let slots = Arc::new(tokio::sync::Semaphore::new(16));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let path = directory.join("mcp.sock");
        if path.exists() {
            std::fs::remove_file(&path)?;
        }
        let listener = tokio::net::UnixListener::bind(&path)?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        private_write(
            &directory.join("endpoint.json"),
            &serde_json::to_vec(&path.to_string_lossy())?,
        )?;
        loop {
            let (stream, _) = listener.accept().await?;
            let Ok(permit) = slots.clone().try_acquire_owned() else {
                continue;
            };
            let app = app.clone();
            tokio::spawn(async move {
                let _permit = permit;
                if let Err(error) = serve(stream, app).await {
                    log::warn!("MCP session ended: {error}");
                }
            });
        }
    }
    #[cfg(windows)]
    {
        use tokio::net::windows::named_pipe::ServerOptions;
        let path = format!(r"\\.\pipe\klaxon-mcp-{}", uuid::Uuid::new_v4());
        let mut listener = ServerOptions::new()
            .first_pipe_instance(true)
            .reject_remote_clients(true)
            .create(&path)?;
        private_write(
            &directory.join("endpoint.json"),
            &serde_json::to_vec(&path)?,
        )?;
        loop {
            listener.connect().await?;
            let connected = listener;
            listener = ServerOptions::new()
                .reject_remote_clients(true)
                .create(&path)?;
            let Ok(permit) = slots.clone().try_acquire_owned() else {
                continue;
            };
            let app = app.clone();
            tokio::spawn(async move {
                let _permit = permit;
                if let Err(error) = serve(connected, app).await {
                    log::warn!("MCP session ended: {error}");
                }
            });
        }
    }
}
async fn bridge<S: AsyncRead + AsyncWrite + Unpin>(mut stream: S, client: Client) -> AppResult<()> {
    let mut frame = serde_json::to_vec(&Auth {
        id: client.id,
        token: client.token,
    })?;
    frame.push(b'\n');
    stream.write_all(&frame).await?;
    if stream.read_u8().await? != b'\n' {
        return Err(AppError::Invalid("Agent access denied".into()));
    }
    let (mut read, mut write) = tokio::io::split(stream);
    let mut stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    tokio::select! {
        result=tokio::io::copy(&mut stdin,&mut write)=>{result?;}
        result=tokio::io::copy(&mut read,&mut stdout)=>{result?;}
    }
    stdout.flush().await?;
    Ok(())
}
pub fn run_bridge(args: Vec<String>) -> AppResult<()> {
    let value = |flag: &str| {
        args.iter()
            .position(|a| a == flag)
            .and_then(|i| args.get(i + 1))
            .cloned()
            .ok_or_else(|| {
                AppError::Invalid(format!("Missing {flag}; use Settings → Agent access"))
            })
    };
    let id = value("--client")?;
    let directory = PathBuf::from(value("--agent-directory")?);
    let clients: Vec<Client> =
        serde_json::from_slice(&std::fs::read(directory.join("clients.json"))?)?;
    let client = clients.into_iter().find(|c| c.id == id).ok_or_else(|| {
        AppError::Invalid("This agent client was revoked. Configure it in Klaxon Settings.".into())
    })?;
    let endpoint: String =
        serde_json::from_slice(&std::fs::read(directory.join("endpoint.json"))?)?;
    tokio::runtime::Runtime::new()?.block_on(async move {
        #[cfg(unix)]
        let stream = tokio::net::UnixStream::connect(endpoint).await?;
        #[cfg(windows)]
        let stream = tokio::net::windows::named_pipe::ClientOptions::new().open(endpoint)?;
        bridge(stream, client).await
    })
}
