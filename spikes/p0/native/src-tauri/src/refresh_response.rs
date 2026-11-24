use serde::de::{value::MapAccessDeserializer, MapAccess, Visitor};
use serde::{Deserialize, Deserializer};
use std::{fmt, marker::PhantomData};

pub(super) struct Grant {
    pub(super) access_token: String,
    pub(super) refresh_token: String,
    pub(super) user_id: String,
}

// Convex 1.51.0 /api/mutation success envelope.
#[derive(Deserialize)]
#[serde(deny_unknown_fields, bound(deserialize = "T: Deserialize<'de>"))]
struct MutationResponse<T> {
    status: String,
    #[serde(deserialize_with = "object")]
    value: T,
    #[serde(rename = "logLines")]
    _log_lines: Option<Vec<String>>,
}

// Auth 2.1.0 vRefreshResult.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum RefreshResult {
    Rotated {
        #[serde(deserialize_with = "object")]
        tokens: TokenBundle,
    },
    NoSession {},
}

// The complete arm of Auth 2.1.0's signInWithUsernamePassword result.
#[derive(Deserialize)]
#[serde(tag = "status", rename_all = "camelCase", deny_unknown_fields)]
enum SignInResult {
    Complete {
        #[serde(deserialize_with = "object")]
        tokens: TokenBundle,
    },
}

// Both Complete and Rotated carry Auth 2.1.0 vTokenBundle.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TokenBundle {
    access_token: String,
    refresh_token: String,
    refresh_token_expires_at: f64,
    user_id: String,
}

impl TokenBundle {
    fn into_grant(self) -> Result<Grant, ()> {
        // Auth computes a Unix timestamp in milliseconds. The provider decides expiry.
        if !self.refresh_token_expires_at.is_finite()
            || self.refresh_token_expires_at <= 0.0
            || self.access_token.trim().is_empty()
            || self.refresh_token.trim().is_empty()
            || self.user_id.trim().is_empty()
        {
            return Err(());
        }

        Ok(Grant {
            access_token: self.access_token,
            refresh_token: self.refresh_token,
            user_id: self.user_id,
        })
    }
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

fn decode_success<'de, T: Deserialize<'de>>(body: &'de [u8]) -> Result<T, ()> {
    let mut json = serde_json::Deserializer::from_slice(body);
    let response: MutationResponse<T> = object(&mut json).map_err(|_| ())?;
    json.end().map_err(|_| ())?;
    if response.status != "success" {
        return Err(());
    }
    Ok(response.value)
}

pub(super) fn decode(body: &[u8]) -> Result<Option<Grant>, ()> {
    match decode_success(body)? {
        RefreshResult::Rotated { tokens } => tokens.into_grant().map(Some),
        RefreshResult::NoSession {} => Ok(None),
    }
}

// Available for native fixture integration.
#[allow(dead_code)]
pub(super) fn decode_sign_in(body: &[u8], expected_owner: &str) -> Result<Grant, ()> {
    let SignInResult::Complete { tokens } = decode_success(body)?;
    if tokens.user_id != expected_owner {
        return Err(());
    }
    tokens.into_grant()
}

#[cfg(test)]
mod tests {
    use super::{decode, decode_sign_in};

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

    const SIGN_IN: &str = r#"{
        "status": "success",
        "value": {"status": "complete", "tokens": {
            "accessToken": "inert-access",
            "refreshToken": "inert-refresh",
            "refreshTokenExpiresAt": 1700000000000.25,
            "userId": "inert-owner"
        }},
        "logLines": ["inert provider output"]
    }"#;

    #[test]
    fn decodes_a_complete_sign_in_for_the_expected_owner() {
        let grant = decode_sign_in(SIGN_IN.as_bytes(), "inert-owner")
            .expect("expected a complete sign-in grant");
        assert!(grant.access_token == "inert-access", "wrong access field");
        assert!(
            grant.refresh_token == "inert-refresh",
            "wrong refresh field"
        );
        assert!(grant.user_id == "inert-owner", "wrong owner field");
    }

    #[test]
    fn sign_in_rejects_a_different_owner() {
        for owner in ["inert-peer", "INERT-OWNER", "inert-owner ", ""] {
            assert!(decode_sign_in(SIGN_IN.as_bytes(), owner).is_err());
        }
    }

    #[test]
    fn sign_in_rejects_errors_and_noncomplete_results() {
        let cases: &[(&str, &[u8])] = &[
            ("mutation error", br#"{"status":"error","errorMessage":"inert diagnostic","errorData":{},"logLines":[]}"#),
            ("sign-in error", br#"{"status":"success","value":{"status":"error","userError":{"error":"INVALID_CREDENTIALS"}}}"#),
            ("rate limit", br#"{"status":"success","value":{"status":"error","userError":{"error":"RATE_LIMITED","retryAfterMs":1000}}}"#),
            ("unknown sign-in status", br#"{"status":"success","value":{"status":"pending"}}"#),
            ("no refresh session", br#"{"status":"success","value":{"kind":"noSession"}}"#),
            ("rotated refresh", ROTATED.as_bytes()),
        ];
        for (label, body) in cases {
            assert!(
                matches!(decode_sign_in(body, "inert-owner"), Err(())),
                "accepted {label}"
            );
        }
        assert!(decode(SIGN_IN.as_bytes()).is_err());
    }

    #[test]
    fn sign_in_rejects_malformed_envelopes_and_results() {
        let cases: &[(&str, &[u8])] = &[
            ("invalid JSON", b"{"),
            ("bare result", br#"{"status":"complete","tokens":{}}"#),
            ("array envelope", br#"["success",{"status":"complete","tokens":{}}]"#),
            ("null result", br#"{"status":"success","value":null}"#),
            ("array result", br#"{"status":"success","value":["complete",{}]}"#),
            ("missing bundle", br#"{"status":"success","value":{"status":"complete"}}"#),
            ("array bundle", br#"{"status":"success","value":{"status":"complete","tokens":["inert-access","inert-refresh",1,"inert-owner"]}}"#),
        ];
        for (label, body) in cases {
            assert!(
                decode_sign_in(body, "inert-owner").is_err(),
                "accepted {label}"
            );
        }

        let cases = [
            (
                "failed envelope with complete result",
                SIGN_IN.replacen(r#""success""#, r#""error""#, 1),
            ),
            (
                "conflicting envelope status",
                SIGN_IN.replacen(r#""status":"#, r#""status":"error","status":"#, 1),
            ),
            (
                "conflicting result status",
                SIGN_IN.replace(
                    r#""status": "complete""#,
                    r#""status":"error","status":"complete""#,
                ),
            ),
            (
                "error diagnostic with complete result",
                SIGN_IN.replace(
                    r#""status": "complete""#,
                    r#""userError":{"error":"INVALID_CREDENTIALS"},"status":"complete""#,
                ),
            ),
            (
                "non-list logs",
                SIGN_IN.replace(r#"["inert provider output"]"#, r#""inert provider output""#),
            ),
            ("trailing JSON", format!("{SIGN_IN} null")),
        ];
        for (label, body) in cases {
            assert!(body != SIGN_IN, "fixture did not change for {label}");
            assert!(
                decode_sign_in(body.as_bytes(), "inert-owner").is_err(),
                "accepted {label}"
            );
        }
    }

    #[test]
    fn sign_in_rejects_invalid_token_bundles() {
        let cases = [
            (
                "missing access token",
                r#""accessToken": "inert-access","#,
                "",
            ),
            (
                "missing refresh token",
                r#""refreshToken": "inert-refresh","#,
                "",
            ),
            (
                "missing expiry",
                r#""refreshTokenExpiresAt": 1700000000000.25,"#,
                "",
            ),
            (
                "missing owner",
                ",\n            \"userId\": \"inert-owner\"",
                "",
            ),
            ("blank access token", r#""inert-access""#, r#"" ""#),
            ("null access token", r#""inert-access""#, "null"),
            ("empty refresh token", r#""inert-refresh""#, r#""""#),
            ("numeric refresh token", r#""inert-refresh""#, "42"),
            ("blank owner", r#""inert-owner""#, r#"" ""#),
            ("numeric owner", r#""inert-owner""#, "42"),
            (
                "duplicate owner",
                r#""userId": "inert-owner""#,
                r#""userId":"inert-peer","userId":"inert-owner""#,
            ),
            ("string expiry", "1700000000000.25", r#""1700000000000.25""#),
            ("zero expiry", "1700000000000.25", "0"),
            ("negative expiry", "1700000000000.25", "-1"),
            ("out-of-range expiry", "1700000000000.25", "1e999"),
            (
                "encoded nonfinite expiry",
                "1700000000000.25",
                r#"{"$float":"AAAAAAAA8H8="}"#,
            ),
        ];
        for (label, original, replacement) in cases {
            let body = SIGN_IN.replace(original, replacement);
            assert!(body != SIGN_IN, "fixture did not change for {label}");
            assert!(
                decode_sign_in(body.as_bytes(), "inert-owner").is_err(),
                "accepted {label}"
            );
        }
        let body = SIGN_IN.replace(r#""inert-owner""#, r#"" ""#);
        assert!(decode_sign_in(body.as_bytes(), " ").is_err());
    }

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
