//! Kanban boards and cards from OKF frontmatter. Markdown is authoritative: a
//! board is an article with `type: Kanban Board` whose ordered columns are
//! `weave.kanban.columns`; a card is any article with `weave.kanban.board`,
//! `column` and a sparse numeric `rank`. `database.rs` stores the derived rows,
//! which are rebuilt from the files. Mirrors `app/weave/kanban.mjs`.
use serde_json::Value;

pub const BOARD_TYPE: &str = "Kanban Board";

fn section(fields: &Value) -> Option<&serde_json::Map<String, Value>> {
    fields.get("weave")?.as_object()?.get("kanban")?.as_object()
}
/// Strings are trimmed; numbers become their shortest text (`2.0` is `2`).
fn scalar(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(s)) => s.trim().to_string(),
        Some(Value::Number(n)) => match n.as_f64() {
            Some(f) if f.is_finite() && f.fract() == 0.0 && f.abs() < 1e15 => {
                format!("{}", f as i64)
            }
            Some(f) if f.is_finite() => f.to_string(),
            _ => String::new(),
        },
        _ => String::new(),
    }
}
pub fn is_board(fields: &Value) -> bool {
    fields["type"]
        .as_str()
        .is_some_and(|t| t.trim().eq_ignore_ascii_case(BOARD_TYPE))
}
/// A board's columns `(id, title)` in board order, and warnings for skipped entries.
pub fn columns(fields: &Value) -> (Vec<(String, String)>, Vec<String>) {
    let mut columns: Vec<(String, String)> = vec![];
    let mut warnings = vec![];
    let list = section(fields).and_then(|k| k.get("columns"));
    if list.is_some_and(|l| !l.is_null() && !l.is_array()) {
        warnings.push("weave.kanban.columns must be a list.".to_string());
    }
    for (index, entry) in list
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        let (id, title) = match entry.as_object() {
            Some(item) => {
                let id = scalar(item.get("id"));
                let title = scalar(item.get("title"));
                let title = if title.is_empty() { id.clone() } else { title };
                (id, title)
            }
            None => {
                let id = scalar(Some(entry));
                (id.clone(), id)
            }
        };
        if id.is_empty() {
            warnings.push(format!("Column {} has no id.", index + 1));
        } else if columns.iter().any(|(c, _)| *c == id) {
            warnings.push(format!(
                "Column id “{id}” is used more than once; only the first is shown."
            ));
        } else {
            columns.push((id, title));
        }
    }
    (columns, warnings)
}
pub struct Card {
    pub board: String,
    pub column: Option<String>,
    pub rank: Option<f64>,
}
pub fn card(fields: &Value) -> Option<Card> {
    let kanban = section(fields)?;
    let board = scalar(kanban.get("board"));
    if board.is_empty() {
        return None;
    }
    let column = scalar(kanban.get("column"));
    let rank = match kanban.get("rank") {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) if !s.trim().is_empty() => s.trim().parse::<f64>().ok(),
        _ => None,
    }
    .filter(|r| r.is_finite());
    Some(Card {
        board,
        column: (!column.is_empty()).then_some(column),
        rank,
    })
}
pub fn fold(value: &str, sensitive: bool) -> String {
    if sensitive {
        value.to_string()
    } else {
        value.to_lowercase()
    }
}
pub fn filename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}
fn normalize(base: &str, path: &str) -> Option<String> {
    let mut parts: Vec<&str> = base.split('/').filter(|s| !s.is_empty()).collect();
    for p in path.split('/') {
        match p {
            ".." => {
                parts.pop()?;
            }
            "." | "" => (),
            _ => parts.push(p),
        }
    }
    Some(parts.join("/"))
}
/// How a card's `board` value finds its board: a bare filename matches the
/// board with that filename (board names are unique in a workspace); a value
/// containing `/` is a path relative to the card, or with a leading `/` to the
/// workspace root. The key is None when a path leaves the workspace.
pub fn reference(board: &str, source: &str, sensitive: bool) -> (bool, Option<String>) {
    let mut value = board.trim().replace('\\', "/");
    if !value.to_lowercase().ends_with(".md") {
        value.push_str(".md");
    }
    if !value.contains('/') {
        return (false, Some(fold(&value, sensitive)));
    }
    let parent = source.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
    let base = if value.starts_with('/') { "" } else { parent };
    (
        true,
        normalize(base, &value)
            .filter(|k| !k.is_empty())
            .map(|k| fold(&k, sensitive)),
    )
}
/// The `board` value that keeps a card on its board once the board is at
/// `next_target` and the card at `next_source`, in the authored form (filename,
/// root path or relative path, with or without `.md`); None when the authored
/// value still finds the board.
pub fn moved_reference(
    authored: &str,
    next_source: &str,
    next_target: &str,
    sensitive: bool,
) -> Option<String> {
    let value = authored.trim().replace('\\', "/");
    let extension = value.to_lowercase().ends_with(".md");
    let trim = |s: String| {
        if extension {
            s
        } else {
            s[..s.len() - 3].to_string()
        }
    };
    let (by_path, key) = reference(&value, next_source, sensitive);
    let found = if by_path {
        next_target
    } else {
        filename(next_target)
    };
    if key.as_deref() == Some(fold(found, sensitive).as_str()) {
        return None;
    }
    if !by_path {
        return Some(trim(filename(next_target).to_string()));
    }
    if value.starts_with('/') {
        return Some(trim(format!("/{next_target}")));
    }
    Some(trim(crate::markdown::relative_target(
        next_source,
        next_target,
    )))
}
fn indent(line: &str) -> usize {
    line.len() - line.trim_start_matches([' ', '\t']).len()
}
fn plain_safe(value: &str) -> bool {
    !value.is_empty()
        && value.trim() == value
        && !value.starts_with([
            '!', '&', '*', '{', '}', '[', ']', '|', '>', '\'', '"', '%', '@', '`', '#', '-', '?',
            ':', ',',
        ])
        && !value.contains(": ")
        && !value.contains(" #")
        && !value.ends_with(':')
        && value.parse::<f64>().is_err()
        && !["true", "false", "null", "~", "yes", "no", "on", "off"]
            .contains(&value.to_lowercase().as_str())
}
/// Rewrites `weave.kanban.board` in leading frontmatter written in block style,
/// keeping its quoting, any trailing comment and every other byte. None when
/// the key is not found that way (for example in a flow mapping).
pub fn replace_board_reference(text: &str, value: &str) -> Option<String> {
    let mut rows = text.split_inclusive('\n');
    let first = rows.next()?;
    if first.trim_start_matches('\u{feff}').trim_end() != "---" {
        return None;
    }
    let mut lines = vec![];
    let mut at = first.len();
    let mut closed = false;
    for row in rows {
        let line = row.trim_end_matches(['\r', '\n']);
        if ["---", "..."].contains(&line.trim_end()) {
            closed = true;
            break;
        }
        lines.push((at, line));
        at += row.len();
    }
    if !closed {
        return None;
    }
    // The key path weave > kanban > board: indents of the keys found so far,
    // and the indent of the current block's direct children.
    let mut path: Vec<usize> = vec![];
    let mut child: Option<usize> = None;
    for (at, line) in lines {
        let trimmed = line.trim_start_matches([' ', '\t']);
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let depth = indent(line);
        while path.last().is_some_and(|d| depth <= *d) {
            path.pop();
            child = None;
        }
        if !path.is_empty() && child.is_none() {
            child = Some(depth);
        }
        if (path.is_empty() && depth != 0) || child.is_some_and(|c| c != depth) {
            continue;
        }
        let key = ["weave", "kanban", "board"][path.len()];
        let Some(rest) = trimmed
            .strip_prefix(key)
            .and_then(|rest| rest.strip_prefix(':'))
            .filter(|rest| rest.is_empty() || rest.starts_with([' ', '\t']))
        else {
            continue;
        };
        if path.len() < 2 {
            if rest.trim().is_empty() || rest.trim().starts_with('#') {
                path.push(depth);
                child = None;
            }
            continue;
        }
        let lead = rest.len() - rest.trim_start().len();
        let body = rest.trim_start();
        let (old_len, quote) = match body.chars().next() {
            Some(q @ ('"' | '\'')) => {
                let bytes = body.as_bytes();
                let mut end = None;
                let mut i = 1;
                while i < bytes.len() {
                    if q == '"' && bytes[i] == b'\\' {
                        i += 2;
                        continue;
                    }
                    if bytes[i] == q as u8 {
                        if q == '\'' && bytes.get(i + 1) == Some(&b'\'') {
                            i += 2;
                            continue;
                        }
                        end = Some(i + 1);
                        break;
                    }
                    i += 1;
                }
                (end?, Some(q))
            }
            _ => (
                body.find(" #")
                    .unwrap_or(body.len())
                    .min(body.trim_end().len()),
                None,
            ),
        };
        let quoted = || format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""));
        let written = match quote {
            Some('\'') => format!("'{}'", value.replace('\'', "''")),
            Some(_) => quoted(),
            None if plain_safe(value) => value.to_string(),
            None => quoted(),
        };
        let from = at + (line.len() - rest.len()) + lead;
        return Some(format!(
            "{}{}{}",
            &text[..from],
            written,
            &text[from + old_len..]
        ));
    }
    None
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn columns_cards_and_references() {
        let fields = json!({"type":" kanban board ","weave":{"kanban":{"columns":[{"id":"todo","title":"To do"},"Done",{"title":"No id"},{"id":"todo"},{"id":2.0}]}}});
        assert!(is_board(&fields));
        let (cols, warnings) = columns(&fields);
        assert_eq!(
            cols,
            vec![
                ("todo".into(), "To do".into()),
                ("Done".into(), "Done".into()),
                ("2".into(), "2".into())
            ]
        );
        assert_eq!(warnings.len(), 2);
        let c =
            card(&json!({"weave":{"kanban":{"board":"Dev.md","column":"todo","rank":"2500.5"}}}))
                .unwrap();
        assert_eq!(
            (c.board.as_str(), c.column.as_deref(), c.rank),
            ("Dev.md", Some("todo"), Some(2500.5))
        );
        assert!(card(&json!({"weave":{"kanban":{"column":"todo"}}})).is_none());
        assert_eq!(
            reference("Dev", "a/b.md", false),
            (false, Some("dev.md".into()))
        );
        assert_eq!(
            reference("../Boards/Dev.md", "a/b.md", true),
            (true, Some("Boards/Dev.md".into()))
        );
        assert_eq!(
            reference("/x/Dev.md", "a/b.md", true),
            (true, Some("x/Dev.md".into()))
        );
        assert_eq!(reference("../../Dev.md", "a/b.md", true), (true, None));
    }
    #[test]
    fn moved_references_keep_their_form() {
        assert_eq!(moved_reference("Dev.md", "c.md", "b/Dev.md", false), None);
        assert_eq!(
            moved_reference("Dev", "c.md", "Team.md", false).as_deref(),
            Some("Team")
        );
        assert_eq!(
            moved_reference("/a/Dev.md", "c.md", "b/Dev.md", true).as_deref(),
            Some("/b/Dev.md")
        );
        assert_eq!(
            moved_reference("./Dev.md", "x/c.md", "Dev.md", true).as_deref(),
            Some("../Dev.md")
        );
    }
    #[test]
    fn board_values_are_rewritten_in_place() {
        let text = "---\ntype: Note\nweave:\n  # cards\n  kanban:\n    board: Dev.md # here\n    column: todo\n---\nboard: body\n";
        assert_eq!(
            replace_board_reference(text, "Team.md").unwrap(),
            "---\ntype: Note\nweave:\n  # cards\n  kanban:\n    board: Team.md # here\n    column: todo\n---\nboard: body\n"
        );
        let quoted = "---\r\nweave:\r\n  kanban:\r\n    board: 'Old board.md'\r\n---\r\n";
        assert_eq!(
            replace_board_reference(quoted, "It's.md").unwrap(),
            "---\r\nweave:\r\n  kanban:\r\n    board: 'It''s.md'\r\n---\r\n"
        );
        assert_eq!(
            replace_board_reference("---\nweave:\n  kanban:\n    board: a.md\n", "b: c.md"),
            None,
            "unclosed frontmatter"
        );
        assert_eq!(
            replace_board_reference("---\nweave: {kanban: {board: a.md}}\n---\n", "b.md"),
            None
        );
        assert_eq!(
            replace_board_reference("---\nother:\n  kanban:\n    board: a.md\n---\n", "b.md"),
            None,
            "only weave.kanban.board"
        );
    }
}
