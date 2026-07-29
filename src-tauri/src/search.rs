//! Turning user-typed text into a safe FTS5 `MATCH` expression.
//!
//! Everything the user types must be treated as literal text. FTS5's query
//! language would otherwise interpret bare words like `AND`/`OR`/`NEAR` as
//! operators, and characters like `"` or `-` as syntax — so `can't` and
//! `foo-bar` would error or quietly mean something else. Quoting every
//! token makes all of it literal; the trailing `*` on the last token is the
//! one piece of deliberate query syntax, giving live prefix matching as the
//! user types.

/// Build an FTS5 `MATCH` expression from raw user input.
///
/// Every whitespace-separated token is wrapped in double quotes (with any
/// embedded quote doubled, which is how FTS5 escapes them), so no token can
/// act as an operator. The final token gets a trailing `*` so results narrow
/// as the user types. Returns `None` when there is nothing to search for.
pub fn to_match_query(raw: &str) -> Option<String> {
    let tokens: Vec<&str> = raw.split_whitespace().collect();
    if tokens.is_empty() {
        return None;
    }

    let last = tokens.len() - 1;
    let mut out = String::new();
    for (i, token) in tokens.iter().enumerate() {
        if i > 0 {
            out.push(' ');
        }
        out.push('"');
        out.push_str(&token.replace('"', "\"\""));
        out.push('"');
        if i == last {
            out.push('*');
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::to_match_query;

    #[test]
    fn empty_input_has_no_query() {
        assert_eq!(to_match_query(""), None);
        assert_eq!(to_match_query("   "), None);
    }

    #[test]
    fn single_token_gets_a_prefix_wildcard() {
        assert_eq!(to_match_query("bread"), Some("\"bread\"*".to_string()));
    }

    #[test]
    fn only_the_last_token_is_a_prefix() {
        assert_eq!(
            to_match_query("sourdough bread"),
            Some("\"sourdough\" \"bread\"*".to_string())
        );
    }

    #[test]
    fn operators_are_literal_not_syntax() {
        // Bare AND/OR would be FTS5 operators if unquoted.
        assert_eq!(
            to_match_query("cats OR dogs"),
            Some("\"cats\" \"OR\" \"dogs\"*".to_string())
        );
    }

    #[test]
    fn embedded_quotes_are_escaped_by_doubling() {
        assert_eq!(
            to_match_query("say \"hi\""),
            Some("\"say\" \"\"\"hi\"\"\"*".to_string())
        );
    }

    #[test]
    fn punctuation_survives_as_literal_text() {
        // A bare `-` would be a NOT operator; `*` mid-token a wildcard.
        assert_eq!(to_match_query("foo-bar"), Some("\"foo-bar\"*".to_string()));
        assert_eq!(to_match_query("can't"), Some("\"can't\"*".to_string()));
    }

    #[test]
    fn a_lone_quote_does_not_produce_broken_syntax() {
        // Regression: a naive implementation emits an unbalanced quote here.
        assert_eq!(to_match_query("\""), Some("\"\"\"\"*".to_string()));
    }
}
