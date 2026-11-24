use serde::de::{value::MapAccessDeserializer, MapAccess, Visitor};
use serde::{Deserialize, Deserializer};
use std::{fmt, marker::PhantomData};

pub(super) struct Grant {
    pub(super) access_token: String,
    pub(super) refresh_token: String,
    pub(super) user_id: String,
}

// Convex 1.51.0 /api/mutation success envelope and Auth 2.1.0 vRefreshResult.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MutationResponse {
    status: String,
    #[serde(deserialize_with = "object")]
    value: RefreshResult,
    #[serde(rename = "logLines")]
    _log_lines: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum RefreshResult {
    Rotated {
        #[serde(deserialize_with = "object")]
        tokens: TokenBundle,
    },
    NoSession {},
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TokenBundle {
    access_token: String,
    refresh_token: String,
    refresh_token_expires_at: f64,
    user_id: String,
}

// Serde structs can also read sequences. Require objects at the JSON boundaries.
fn object<'de, D: Deserializer<'de>, T: Deserialize<'de>>(input: D) -> Result<T, D::Error> {
    struct ObjectVisitor<T>(PhantomData<T>);

    impl<'de, T: Deserialize<'de>> Visitor<'de> for ObjectVisitor<T> {
        type Value = T;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("a JSON object")
        }

        fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<T, A::Error> {
            T::deserialize(MapAccessDeserializer::new(map))
        }
    }

    input.deserialize_map(ObjectVisitor(PhantomData))
}

pub(super) fn decode(body: &[u8]) -> Result<Option<Grant>, ()> {
    let mut json = serde_json::Deserializer::from_slice(body);
    let response: MutationResponse = object(&mut json).map_err(|_| ())?;
    json.end().map_err(|_| ())?;
    if response.status != "success" {
        return Err(());
    }

    let RefreshResult::Rotated { tokens } = response.value else {
        return Ok(None);
    };

    // Auth computes a Unix timestamp in milliseconds. The provider decides expiry.
    if !tokens.refresh_token_expires_at.is_finite()
        || tokens.refresh_token_expires_at <= 0.0
        || tokens.access_token.trim().is_empty()
        || tokens.refresh_token.trim().is_empty()
        || tokens.user_id.trim().is_empty()
    {
        return Err(());
    }

    Ok(Some(Grant {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        user_id: tokens.user_id,
    }))
}

#[cfg(test)]
mod tests {
    use super::decode;

    const ROTATED: &str = r#"{
        "status": "success",
        "value": {"kind": "rotated", "tokens": {
            "accessToken": "inert-access",
            "refreshToken": "inert-refresh",
            "refreshTokenExpiresAt": 1700000000000.25,
            "userId": "inert-owner"
        }},
        "logLines": ["inert provider output"]
    }"#;

    #[test]
    fn decodes_the_rotated_grant_with_its_owner() {
        let grant = decode(ROTATED.as_bytes())
            .expect("expected a valid envelope")
            .expect("expected a rotated grant");
        assert!(grant.access_token == "inert-access", "wrong access field");
        assert!(
            grant.refresh_token == "inert-refresh",
            "wrong refresh field"
        );
        assert!(grant.user_id == "inert-owner", "wrong owner field");
    }

    #[test]
    fn accepts_definitive_no_session() {
        let body = br#"{"status":"success","value":{"kind":"noSession"}}"#;
        assert!(matches!(decode(body), Ok(None)));
    }

    #[test]
    fn rejects_failed_mutations_even_if_the_value_says_no_session() {
        let error =
            br#"{"status":"error","errorMessage":"inert failure","errorData":null,"logLines":[]}"#;
        let error_with_value = br#"{"status":"error","value":{"kind":"noSession"}}"#;
        assert!(decode(error).is_err());
        assert!(decode(error_with_value).is_err());
    }

    #[test]
    fn rejects_malformed_envelopes_and_values() {
        let cases: &[(&str, &[u8])] = &[
            ("empty input", b""),
            ("malformed JSON", b"{"),
            ("trailing data", br#"{"status":"success","value":{"kind":"noSession"}} null"#),
            ("bare noSession", br#"{"kind":"noSession"}"#),
            ("array envelope", br#"["success",{"kind":"noSession"},[]]"#),
            ("object status", br#"{"status":{"success":null},"value":{"kind":"noSession"}}"#),
            ("missing value", br#"{"status":"success"}"#),
            ("null value", br#"{"status":"success","value":null}"#),
            ("unknown kind", br#"{"status":"success","value":{"kind":"unknown"}}"#),
            ("missing bundle", br#"{"status":"success","value":{"kind":"rotated"}}"#),
            ("conflicting kind", br#"{"status":"success","value":{"kind":"rotated","kind":"noSession"}}"#),
            ("extra noSession field", br#"{"status":"success","value":{"kind":"noSession","tokens":null}}"#),
            ("conflicting status", br#"{"status":"error","status":"success","value":{"kind":"noSession"}}"#),
            ("mixed success and error", br#"{"status":"success","errorMessage":"inert failure","value":{"kind":"noSession"}}"#),
            ("array value", br#"{"status":"success","value":["noSession"]}"#),
            ("array bundle", br#"{"status":"success","value":{"kind":"rotated","tokens":["inert-access","inert-refresh",1,"inert-owner"]}}"#),
        ];
        for (label, body) in cases {
            assert!(decode(body).is_err(), "accepted {label}");
        }
    }

    #[test]
    fn rejects_invalid_grant_fields() {
        let cases = [
            ("empty access token", r#""inert-access""#, "\"\""),
            ("blank refresh token", r#""inert-refresh""#, "\" \""),
            ("empty owner", r#""inert-owner""#, "\"\""),
            ("non-string owner", r#""inert-owner""#, "42"),
            (
                "missing owner",
                ",\n            \"userId\": \"inert-owner\"",
                "",
            ),
            ("string expiry", "1700000000000.25", "\"1700000000000.25\""),
            ("null expiry", "1700000000000.25", "null"),
            ("zero expiry", "1700000000000.25", "0"),
            ("negative expiry", "1700000000000.25", "-1"),
            ("nonfinite expiry", "1700000000000.25", "1e999"),
        ];
        for (label, original, replacement) in cases {
            let body = ROTATED.replace(original, replacement);
            assert!(body != ROTATED, "fixture did not change for {label}");
            assert!(decode(body.as_bytes()).is_err(), "accepted {label}");
        }
    }
}
