pub fn is_canonical_origin(origin: &str) -> bool {
    let Some(slug) = origin
        .strip_prefix("https://")
        .and_then(|host| host.strip_suffix(".convex.cloud"))
    else {
        return false;
    };
    slug.split('-').all(|segment| {
        !segment.is_empty()
            && segment
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
    })
}

#[cfg(test)]
mod tests {
    use super::is_canonical_origin;

    #[test]
    fn accepts_lowercase_single_label_convex_origins() {
        for origin in [
            "https://a.convex.cloud",
            "https://123.convex.cloud",
            "https://example-dev-123.convex.cloud",
        ] {
            assert!(is_canonical_origin(origin), "{origin}");
        }
    }

    #[test]
    fn rejects_noncanonical_or_other_origins() {
        for origin in [
            "",
            "http://example.convex.cloud",
            "https://example.convex.site",
            "https://Example.convex.cloud",
            "https://example.CONVEX.cloud",
            "https://convex.cloud",
            "https://first.example.convex.cloud",
            "https://-example.convex.cloud",
            "https://example-.convex.cloud",
            "https://example--dev.convex.cloud",
            "https://example_dev.convex.cloud",
            "https://éxample.convex.cloud",
            "https://user@example.convex.cloud",
            "https://example.convex.cloud:443",
            "https://example.convex.cloud/",
            "https://example.convex.cloud/api/mutation",
            "https://example.convex.cloud?",
            "https://example.convex.cloud#",
            "https://example.convex.cloud.evil.test",
            "https://example.convex.cloud.",
            "https://example.convex.cloud\n",
            " https://example.convex.cloud",
        ] {
            assert!(!is_canonical_origin(origin), "{origin:?}");
        }
    }
}
