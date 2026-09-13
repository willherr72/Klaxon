//! Authenticated sync dispatch, independent of transport and UI plumbing.
use crate::db::{peers, sync_log};
use crate::error::{AppError, AppResult};
use crate::sync::{
    proto::{self, RpcEnvelope, RpcRequest, RpcResponse},
    storage::{self, Applied},
    DeviceIdentity,
};
use rusqlite::{Connection, OptionalExtension};

pub fn dispatch(
    db: &Connection,
    identity: &DeviceIdentity,
    env: RpcEnvelope,
    legacy: bool,
    negotiated: bool,
) -> AppResult<(RpcResponse, Option<Applied>)> {
    let peer: Option<String> = db
        .query_row(
            "SELECT id FROM peers WHERE shared_secret = ?1",
            [&env.secret],
            |r| r.get(0),
        )
        .optional()?;
    let Some(peer) = peer else {
        return Ok((RpcResponse::Error("unauthorized".into()), None));
    };
    let reply = match env.request {
        RpcRequest::Ping => RpcResponse::Pong(crate::sync::ops::ping(identity)),
        RpcRequest::Hello { app_version } => {
            peers::set_app_version(db, &peer, Some(&app_version))?;
            RpcResponse::Hello {
                app_version: env!("CARGO_PKG_VERSION").into(),
            }
        }
        _ if legacy => RpcResponse::Error(proto::UPDATE_REQUIRED.into()),
        RpcRequest::HelloV1 {
            protocol,
            app_version,
        } => {
            proto::validate_protocol(protocol)?;
            peers::set_app_version(db, &peer, Some(&app_version))?;
            RpcResponse::HelloV1 {
                protocol: proto::PROTOCOL_VERSION,
                app_version: env!("CARGO_PKG_VERSION").into(),
            }
        }
        RpcRequest::Pull { .. } | RpcRequest::Push(_) => {
            RpcResponse::Error(proto::UPDATE_REQUIRED.into())
        }
        _ if !negotiated => RpcResponse::Error(
            "Sync protocol negotiation required before transferring data.".into(),
        ),
        RpcRequest::PullV1 { since } => {
            RpcResponse::PullV1(sync_log::snapshot(db, since.as_ref())?)
        }
        RpcRequest::PushV1(batch) => {
            if batch.cursor.epoch.is_empty()
                || batch.cursor.epoch.len() > 128
                || batch.cursor.revision < 0
            {
                return Err(AppError::Invalid("Invalid delivery cursor".into()));
            }
            let applied = storage::apply(db, &batch.changes)?;
            return Ok((
                RpcResponse::PushV1 {
                    cursor: batch.cursor,
                },
                Some(applied),
            ));
        }
    };
    Ok((reply, None))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::proto::{RpcRequest, PROTOCOL_VERSION};

    fn db() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&db).unwrap();
        db.execute("INSERT INTO peers(id,name,shared_secret,created_at) VALUES ('p','phone','test-secret',1)", []).unwrap();
        db
    }

    fn call(
        db: &Connection,
        request: RpcRequest,
        legacy: bool,
        negotiated: bool,
    ) -> AppResult<(RpcResponse, Option<Applied>)> {
        dispatch(
            db,
            &DeviceIdentity {
                device_id: "laptop".into(),
                device_name: "Laptop".into(),
            },
            RpcEnvelope {
                secret: "test-secret".into(),
                request,
            },
            legacy,
            negotiated,
        )
    }

    #[test]
    fn legacy_data_requests_produce_an_update_error() {
        let (response, effects) = call(&db(), RpcRequest::Pull { since: 0 }, true, false).unwrap();
        assert!(matches!(response, RpcResponse::Error(ref msg) if msg.contains("Update")));
        assert!(effects.is_none());
    }

    #[test]
    fn new_protocol_requires_hello_before_reading_data() {
        let db = db();
        let (response, _) = call(&db, RpcRequest::PullV1 { since: None }, false, false).unwrap();
        assert!(matches!(response, RpcResponse::Error(_)));
        let (response, _) = call(&db, RpcRequest::PullV1 { since: None }, false, true).unwrap();
        assert!(matches!(response, RpcResponse::PullV1(_)));
    }

    #[test]
    fn compatible_hello_records_version_but_unknown_protocol_fails() {
        let db = db();
        let (response, _) = call(
            &db,
            RpcRequest::HelloV1 {
                protocol: PROTOCOL_VERSION,
                app_version: "0.10.3".into(),
            },
            false,
            false,
        )
        .unwrap();
        assert!(matches!(response, RpcResponse::HelloV1 { protocol: 1, .. }));
        let version: String = db
            .query_row("SELECT last_app_version FROM peers WHERE id='p'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(version, "0.10.3");
        assert!(call(
            &db,
            RpcRequest::HelloV1 {
                protocol: 999,
                app_version: "99.0.0".into()
            },
            false,
            false
        )
        .is_err());
    }

    #[test]
    fn wrong_secret_cannot_read_or_mutate() {
        let db = db();
        let (response, effects) = dispatch(
            &db,
            &DeviceIdentity {
                device_id: "laptop".into(),
                device_name: "Laptop".into(),
            },
            RpcEnvelope {
                secret: "wrong".into(),
                request: RpcRequest::PullV1 { since: None },
            },
            false,
            true,
        )
        .unwrap();
        assert!(matches!(response, RpcResponse::Error(ref msg) if msg == "unauthorized"));
        assert!(effects.is_none());
    }
}
