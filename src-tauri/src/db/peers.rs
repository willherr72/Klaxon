use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::error::AppResult;
use crate::models::now_ms;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Peer {
    pub id: String,
    pub name: String,
    pub url: String,
    pub shared_secret: String,
    pub last_pull_at: i64,
    pub last_push_at: i64,
    pub created_at: i64,
    pub last_seen_at: Option<i64>,
    pub cert_fingerprint: Option<String>,
    /// Iroh EndpointId (base32 string) captured during pairing. `None` for
    /// peers that paired under v0.2 — they need to re-pair to get
    /// cross-network sync via the iroh transport.
    pub iroh_node_id: Option<String>,
}

pub fn list_all(conn: &Connection) -> AppResult<Vec<Peer>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, url, shared_secret, last_pull_at, last_push_at, created_at,
                last_seen_at, cert_fingerprint, iroh_node_id
         FROM peers ORDER BY name ASC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Peer {
            id: r.get(0)?,
            name: r.get(1)?,
            url: r.get(2)?,
            shared_secret: r.get(3)?,
            last_pull_at: r.get(4)?,
            last_push_at: r.get(5)?,
            created_at: r.get(6)?,
            last_seen_at: r.get(7)?,
            cert_fingerprint: r.get(8)?,
            iroh_node_id: r.get(9)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn upsert(conn: &Connection, peer: &Peer) -> AppResult<()> {
    conn.execute(
        "INSERT INTO peers (id, name, url, shared_secret, last_pull_at, last_push_at,
                            created_at, last_seen_at, cert_fingerprint, iroh_node_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            url = excluded.url,
            shared_secret = excluded.shared_secret,
            cert_fingerprint = excluded.cert_fingerprint,
            iroh_node_id = COALESCE(excluded.iroh_node_id, peers.iroh_node_id)",
        params![
            peer.id,
            peer.name,
            peer.url,
            peer.shared_secret,
            peer.last_pull_at,
            peer.last_push_at,
            peer.created_at,
            peer.last_seen_at,
            peer.cert_fingerprint,
            peer.iroh_node_id,
        ],
    )?;
    Ok(())
}

/// Lookup by EndpointId — used by the iroh handler to map an incoming
/// connection back to a paired peer.
#[allow(dead_code)]
pub fn find_by_node_id(conn: &Connection, node_id: &str) -> AppResult<Option<Peer>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, url, shared_secret, last_pull_at, last_push_at, created_at,
                last_seen_at, cert_fingerprint, iroh_node_id
         FROM peers WHERE iroh_node_id = ?1 LIMIT 1",
    )?;
    let mut rows = stmt.query_map(params![node_id], |r| {
        Ok(Peer {
            id: r.get(0)?,
            name: r.get(1)?,
            url: r.get(2)?,
            shared_secret: r.get(3)?,
            last_pull_at: r.get(4)?,
            last_push_at: r.get(5)?,
            created_at: r.get(6)?,
            last_seen_at: r.get(7)?,
            cert_fingerprint: r.get(8)?,
            iroh_node_id: r.get(9)?,
        })
    })?;
    if let Some(row) = rows.next() {
        Ok(Some(row?))
    } else {
        Ok(None)
    }
}

pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM peers WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn mark_pulled(conn: &Connection, id: &str, ts: i64) -> AppResult<()> {
    conn.execute(
        "UPDATE peers SET last_pull_at = ?2, last_seen_at = ?2 WHERE id = ?1",
        params![id, ts],
    )?;
    Ok(())
}

pub fn mark_pushed(conn: &Connection, id: &str, ts: i64) -> AppResult<()> {
    conn.execute(
        "UPDATE peers SET last_push_at = ?2, last_seen_at = ?2 WHERE id = ?1",
        params![id, ts],
    )?;
    Ok(())
}

pub fn touch_seen(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE peers SET last_seen_at = ?2 WHERE id = ?1",
        params![id, now_ms()],
    )?;
    Ok(())
}
