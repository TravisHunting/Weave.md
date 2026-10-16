//! OKF inline article links. Byte spans are used for edits; IPC spans use UTF-16.
use regex::Regex;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::sync::LazyLock;
fn re(s: &str) -> Regex {
    Regex::new(s).unwrap()
}
static HEADING: LazyLock<Regex> =
    LazyLock::new(|| re(r"^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$"));
static TAGS: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)^\s*(?:\*\*)?(?:Topics|Tags)(?:\*\*)?:\s*(.+?)\s*$"));
static REL: LazyLock<Regex> = LazyLock::new(|| re(r"^[\p{L}\p{N}][\p{L}\p{N}_-]*$"));
static SCHEME: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)^[a-z][a-z0-9+.-]*:"));
pub fn plain(s: &str) -> String {
    static P: LazyLock<Regex> = LazyLock::new(|| {
        re(r"\\([\\_*~`\[\]<>#()!|])|`+([^`]+)`+|\*\*([^*]+)\*\*|\[([^\]]+)\]\([^)]+\)")
    });
    P.replace_all(s, |c: &regex::Captures| {
        c.iter()
            .skip(1)
            .flatten()
            .next()
            .unwrap()
            .as_str()
            .to_string()
    })
    .into_owned()
}
pub fn metadata(text: &str, path: &str, root: &str) -> Value {
    let mut body = text;
    let mut fields = json!({});
    let mut warning = Value::Null;
    if text.lines().next().is_some_and(|s| s.trim_end() == "---") {
        let start = text.find('\n').unwrap_or(text.len()) + 1;
        let mut at = start;
        for row in text.get(start..).unwrap_or("").split_inclusive('\n') {
            if ["---", "..."].contains(&row.trim()) {
                match serde_yaml::from_str::<Value>(&text[start..at]) {
                    Ok(v) if v.is_object() => fields = v,
                    Ok(_) => warning = json!("Frontmatter must be a mapping"),
                    Err(e) => warning = json!(e.to_string()),
                }
                body = &text[at + row.len()..];
                break;
            }
            at += row.len();
        }
    }
    let filename = path.rsplit('/').next().unwrap_or(path);
    let filename = &filename[..filename.len().saturating_sub(3)];
    let heading = HEADING
        .captures(body.lines().next().unwrap_or(""))
        .map(|c| plain(&c[1]));
    let title = fields["title"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().to_string())
        .or_else(|| fields["title"].as_number().map(ToString::to_string))
        .or(heading.clone())
        .unwrap_or(filename.into());
    let mut tags = vec![];
    if let Some(a) = fields["tags"].as_array() {
        for t in a {
            if let Some(s) = t.as_str() {
                tags.push(s.to_string());
            }
        }
    } else if let Some(tag) = fields["tags"].as_str() {
        if !tag.trim().is_empty() {
            tags.push(tag.trim().to_string());
        }
    }
    let mut fence = None;
    for row in body.lines() {
        let s = row.trim_start();
        if s.starts_with("```") || s.starts_with("~~~") {
            let c = s.as_bytes()[0];
            if fence == Some(c) {
                fence = None;
            } else if fence.is_none() {
                fence = Some(c);
            }
            continue;
        }
        if fence.is_some() {
            continue;
        }
        if let Some(c) = TAGS.captures(row) {
            for t in c[1].trim_end_matches('.').split([',', ';']) {
                let t = plain(t.trim()).trim_start_matches('#').to_string();
                if !t.is_empty() && !tags.contains(&t) {
                    tags.push(t);
                }
            }
        }
    }
    let kind = path
        .rsplit_once('/')
        .map(|(p, _)| p.rsplit('/').next().unwrap_or(root))
        .unwrap_or(root);
    json!({"title":title,"heading":heading,"filename":filename,"type":kind,"tags":tags,"body":body,"metadata":fields,"warning":warning})
}
#[derive(Clone, Debug)]
pub struct Link {
    pub start: usize,
    pub end: usize,
    pub from: usize,
    pub to: usize,
    pub line: usize,
    pub target: String,
    pub relationship: String,
    pub angle: bool,
    pub label: String,
    pub legacy: bool,
}
fn escaped(b: &[u8], at: usize) -> bool {
    let mut i = at;
    while i > 0 && b[i - 1] == b'\\' {
        i -= 1;
    }
    (at - i) % 2 == 1
}
pub fn links(text: &str) -> Vec<Link> {
    parse(text, "").0
}
/// Whether the article has a fenced code block marked `mermaid` (```` ```mermaid ````
/// or `~~~ Mermaid`, also inside lists and quotes), which the reader draws as a diagram.
pub fn has_mermaid_fence(text: &str) -> bool {
    text.lines().any(|line| {
        let line = line.trim_start_matches(|c: char| c == ' ' || c == '\t' || c == '>');
        let fence = line
            .strip_prefix("```")
            .or_else(|| line.strip_prefix("~~~"))
            .map(|rest| rest.trim_start_matches(['`', '~']).trim_start());
        fence
            .and_then(|info| info.split_whitespace().next())
            .is_some_and(|word| word.eq_ignore_ascii_case("mermaid"))
    })
}
pub fn diagnostics(text: &str, source: &str) -> Vec<Value> {
    parse(text, source).1
}
fn parse(text: &str, source: &str) -> (Vec<Link>, Vec<Value>) {
    let b = text.as_bytes();
    let mut out = vec![];
    let mut diagnostics = vec![];
    let (mut i, mut line, mut inline, mut comment) = (0, 1, 0, false);
    let mut fence: Option<(u8, usize)> = None;
    let mut front = text.lines().next().is_some_and(|s| s.trim_end() == "---");
    while i < b.len() {
        if i == 0 || b[i - 1] == b'\n' {
            let end = text[i..].find('\n').map(|e| i + e).unwrap_or(b.len());
            let row = &text[i..end];
            let s = row.trim_end_matches('\r');
            if front {
                if i > 0 && ["---", "..."].contains(&s.trim()) {
                    front = false;
                }
                i = end;
                if i < b.len() {
                    i += 1;
                    line += 1;
                }
                continue;
            }
            let spaces = s.bytes().take_while(|c| *c == b' ').count();
            let trimmed = &s[spaces..];
            let c = trimmed.as_bytes().first().copied().unwrap_or(0);
            let n = trimmed.bytes().take_while(|v| *v == c).count();
            if !comment
                && spaces <= 3
                && [b'`', b'~'].contains(&c)
                && n >= 3
                && (fence.is_none()
                    || fence.is_some_and(|(fc, fn_)| {
                        fc == c && n >= fn_ && trimmed[n..].trim().is_empty()
                    }))
            {
                fence = if fence.is_some() { None } else { Some((c, n)) };
                inline = 0;
                i = end;
                if i < b.len() {
                    i += 1;
                    line += 1;
                }
                continue;
            }
            if fence.is_some() || spaces >= 4 || s.starts_with('\t') {
                i = end;
                if i < b.len() {
                    i += 1;
                    line += 1;
                }
                continue;
            }
        }
        if b[i] == b'\n' {
            line += 1;
            i += 1;
            continue;
        }
        if b[i..].starts_with(b"<!--") && inline == 0 {
            comment = true;
            i += 4;
            continue;
        }
        if comment {
            if b[i..].starts_with(b"-->") {
                comment = false;
                i += 3;
            } else {
                i += 1;
            }
            continue;
        }
        if b[i] == b'\\' && inline == 0 {
            i = (i + 2).min(b.len());
            continue;
        }
        if b[i] == b'`' {
            let n = b[i..].iter().take_while(|c| **c == b'`').count();
            if inline == 0 {
                inline = n;
            } else if inline == n {
                inline = 0;
            }
            i += n;
            continue;
        }
        if inline > 0 || b[i] != b'[' {
            i += 1;
            continue;
        }
        if b[i..].starts_with(b"[[") {
            if let Some(e) = text[i + 2..].find("]]") {
                if !text[i + 2..i + 2 + e].contains('\n') {
                    diagnostics.push(json!({"source":source,"line":line,"start":text[..i].encode_utf16().count(),"message":"Wiki links are not supported; use [Label](/path/article.md \"relationship\")"}));
                    i += e + 4;
                    continue;
                }
            }
        }
        let start = i;
        let mut close = i;
        let mut depth = 0i32;
        while close < b.len() && b[close] != b'\n' {
            if !escaped(b, close) {
                if b[close] == b'`' {
                    let n = b[close..].iter().take_while(|c| **c == b'`').count();
                    let marker = "`".repeat(n);
                    if let Some(end) = text.get(close + n..).and_then(|s| s.find(&marker)) {
                        close += n + end + n;
                        continue;
                    } else {
                        break;
                    }
                }
                if b[close] == b'[' {
                    depth += 1;
                }
                if b[close] == b']' {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
            }
            close += 1;
        }
        if close + 1 >= b.len()
            || b[close] != b']'
            || b[close + 1] != b'('
            || (i > 0 && b[i - 1] == b'!' && !escaped(b, i - 1))
        {
            i += 1;
            continue;
        }
        let mut at = close + 2;
        while at < b.len() && [b' ', b'\t'].contains(&b[at]) {
            at += 1;
        }
        let angle = b.get(at) == Some(&b'<');
        if angle {
            at += 1;
        }
        let from = at;
        let mut depth = 0;
        while at < b.len() {
            let c = b[at];
            if angle {
                if [b'>', b'<', b'\n'].contains(&c) {
                    break;
                }
            } else {
                if c == b'\\' && at + 1 < b.len() {
                    at += 2;
                    continue;
                }
                if c.is_ascii_whitespace() || (c == b')' && depth == 0) {
                    break;
                }
                if c == b'(' {
                    depth += 1;
                }
                if c == b')' {
                    depth -= 1;
                }
            }
            at += 1;
        }
        if !angle && b.get(at) == Some(&b' ') {
            if let Some(end) = text.get(at..).and_then(|s| s.find(')')) {
                let end = at + end;
                let rest = &text[at..end];
                if !rest.contains(['\n', '"', '\'', '('])
                    && text[from..end].trim_end().to_lowercase().ends_with(".md")
                {
                    at = from + text[from..end].trim_end().len();
                }
            }
        }
        let to = at;
        if angle {
            if b.get(at) != Some(&b'>') {
                i = close + 1;
                continue;
            }
            at += 1;
        }
        let after = at;
        while at < b.len() && [b' ', b'\t'].contains(&b[at]) {
            at += 1;
        }
        let mut title = None;
        let quote = match b.get(at) {
            Some(b'"') => Some(b'"'),
            Some(b'\'') => Some(b'\''),
            Some(b'(') => Some(b')'),
            _ => None,
        };
        if at > after {
            if let Some(q) = quote {
                let begin = at + 1;
                at = begin;
                while at < b.len() && b[at] != q && b[at] != b'\n' {
                    at += 1;
                }
                if b.get(at) != Some(&q) {
                    i = close + 1;
                    continue;
                }
                title = Some(text[begin..at].trim());
                at += 1;
                while at < b.len() && [b' ', b'\t'].contains(&b[at]) {
                    at += 1;
                }
            }
        }
        if b.get(at) != Some(&b')') {
            i = close + 1;
            continue;
        }
        at += 1;
        let raw = &text[from..to];
        let raw_path = raw.split(['?', '#']).next().unwrap_or(raw);
        let target = percent_encoding::percent_decode_str(raw_path)
            .decode_utf8()
            .map(|s| s.to_string())
            .unwrap_or(raw_path.into());
        if SCHEME.is_match(raw)
            || raw.starts_with("//")
            || raw.starts_with('#')
            || !target.to_lowercase().ends_with(".md")
        {
            i = close + 1;
            continue;
        }
        let mut legacy = false;
        let mut authored = title.filter(|s| REL.is_match(s));
        if b.get(at..at + 2) == Some(b"@@") {
            let end = text[at + 2..]
                .char_indices()
                .take_while(|(_, c)| c.is_alphanumeric() || *c == '_' || *c == '-')
                .last()
                .map(|(o, c)| at + 2 + o + c.len_utf8())
                .unwrap_or(at + 2);
            if end > at + 2 {
                legacy = true;
                if authored.is_none() {
                    authored = Some(&text[at + 2..end]);
                }
                at = end;
            }
        }
        let rel = authored
            .unwrap_or("links-to")
            .to_lowercase()
            .replace('_', "-");
        if legacy {
            diagnostics.push(json!({"source":source,"line":line,"start":text[..start].encode_utf16().count(),"message":"Unsupported @@relationship suffix; use [Label](/path/article.md \"relationship\")"}));
        }
        let relationship = rel
            .split('-')
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("-");
        out.push(Link {
            start,
            end: at,
            from,
            to,
            line,
            target,
            relationship,
            angle,
            label: plain(&text[start + 1..close]).trim().into(),
            legacy,
        });
        i = at;
    }
    (out, diagnostics)
}
pub struct Resolver {
    exact: HashMap<String, Vec<String>>,
    base: HashMap<String, Vec<String>>,
    sensitive: bool,
}
impl Resolver {
    pub fn new(paths: impl Iterator<Item = String>, sensitive: bool) -> Self {
        let mut r = Self {
            exact: HashMap::new(),
            base: HashMap::new(),
            sensitive,
        };
        for p in paths {
            r.exact.entry(r.key(&p)).or_default().push(p.clone());
            r.base
                .entry(r.key(p.rsplit('/').next().unwrap()))
                .or_default()
                .push(p);
        }
        r
    }
    fn key(&self, s: &str) -> String {
        if self.sensitive {
            s.into()
        } else {
            s.to_lowercase()
        }
    }
    pub fn resolve(&self, authored: &str, source: &str) -> Value {
        let raw = authored.trim().replace('\\', "/");
        let parent = source.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
        let mut options = vec![];
        if raw.starts_with('/') {
            options.push((normalize("", raw.trim_start_matches('/')), false));
        } else {
            options.push((normalize(parent, &raw), false));
            if !raw.starts_with("./") && !raw.starts_with("../") && !parent.is_empty() {
                options.push((normalize("", &raw), true));
            }
        }
        let mut target = options
            .first()
            .and_then(|(s, _)| s.clone())
            .unwrap_or(raw.clone());
        if options.iter().any(|(s, _)| s.is_none()) || target.contains(':') {
            return json!({"resolved":false,"resolvedPath":null,"targetPath":target,"reason":"invalid-path","candidates":[],"fallback":false});
        }
        let mut matches = vec![];
        let mut fallback = false;
        for (p, f) in options {
            if let Some(p) = p {
                if let Some(m) = self.exact.get(&self.key(&p)) {
                    matches = m.clone();
                    target = p;
                    fallback = f;
                    break;
                }
            }
        }
        if matches.is_empty() && !raw.contains('/') {
            matches = self.base.get(&self.key(&raw)).cloned().unwrap_or_default();
            fallback = true;
        }
        let resolved = matches.len() == 1;
        json!({"resolved":resolved,"resolvedPath":if resolved{Some(&matches[0])}else{None},"targetPath":target,"reason":if resolved{None}else if matches.is_empty(){Some("missing")}else{Some("ambiguous")},"candidates":matches,"fallback":resolved&&fallback})
    }
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
pub fn relative_target(source: &str, target: &str) -> String {
    let a: Vec<_> = source.split('/').collect();
    let a = &a[..a.len() - 1];
    let b: Vec<_> = target.split('/').collect();
    let mut shared = 0;
    while shared < a.len() && shared < b.len() - 1 && a[shared] == b[shared] {
        shared += 1;
    }
    format!(
        "{}{}",
        if shared < a.len() {
            "../".repeat(a.len() - shared)
        } else {
            "./".into()
        },
        b[shared..].join("/")
    )
}
pub fn rewrite(
    text: &str,
    source: &str,
    next_source: &str,
    mapping: &BTreeMap<String, String>,
    resolver: &Resolver,
) -> (String, usize) {
    let mut result = text.to_string();
    let mut count = 0;
    for l in links(text).into_iter().rev() {
        let r = resolver.resolve(&l.target, source);
        let Some(target) = r["resolvedPath"].as_str() else {
            continue;
        };
        let next = mapping.get(target).map(String::as_str).unwrap_or(target);
        let absolute = l.target.starts_with('/');
        if next == target && (absolute || source == next_source) {
            continue;
        }
        let mut dest = if absolute {
            format!("/{next}")
        } else {
            relative_target(next_source, next)
        };
        if !l.angle
            && dest
                .chars()
                .any(|c| c.is_whitespace() || "()<>".contains(c))
        {
            dest = format!("<{dest}>");
        }
        if text[l.from..l.to] != dest {
            result.replace_range(l.from..l.to, &dest);
            count += 1;
        }
    }
    (result, count)
}
/// Sets `updated_at` in leading OKF frontmatter, adding the key before the
/// closing fence when it is absent. Text without (closed) frontmatter is
/// returned unchanged: Weave's editor adds the block when an article is saved.
pub fn touch_updated(text: &str, stamp: &str) -> String {
    let mut rows = text.split_inclusive('\n');
    let Some(first) = rows.next() else {
        return text.to_string();
    };
    if first.trim_end() != "---" {
        return text.to_string();
    }
    let newline = if first.ends_with("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut at = first.len();
    for row in rows {
        let line = row.trim_end_matches(['\r', '\n']);
        if ["---", "..."].contains(&line.trim_end()) {
            return format!("{}updated_at: {stamp}{newline}{}", &text[..at], &text[at..]);
        }
        if line.starts_with("updated_at:") {
            return format!(
                "{}updated_at: {stamp}{}",
                &text[..at],
                &text[at + line.len()..]
            );
        }
        at += row.len();
    }
    text.to_string()
}
/// The reader's link records for one article, with UTF-16 offsets computed in
/// one pass over the text (per-link prefixes would be quadratic).
pub fn links_json(links: &[Link], text: &str, source: &str) -> Vec<Value> {
    let mut positions: Vec<usize> = links
        .iter()
        .flat_map(|l| [l.start, l.end, l.from, l.to])
        .collect();
    positions.sort_unstable();
    positions.dedup();
    let mut offsets = HashMap::with_capacity(positions.len());
    let (mut byte, mut units) = (0, 0);
    for p in positions {
        units += text[byte..p].encode_utf16().count();
        byte = p;
        offsets.insert(p, units);
    }
    links.iter().map(|l| json!({"source":source,"target":l.target,"relationship":l.relationship,"label":if l.label.is_empty(){None}else{Some(&l.label)},"start":offsets[&l.start],"end":offsets[&l.end],"targetStart":offsets[&l.from],"targetEnd":offsets[&l.to],"angle":l.angle,"line":l.line,"raw":&text[l.start..l.end],"legacySuffix":l.legacy})).collect()
}
pub fn link_json(l: &Link, text: &str, source: &str) -> Value {
    let offset = |i| text[..i].encode_utf16().count();
    json!({"source":source,"target":l.target,"relationship":l.relationship,"label":if l.label.is_empty(){None}else{Some(&l.label)},"start":offset(l.start),"end":offset(l.end),"targetStart":offset(l.from),"targetEnd":offset(l.to),"angle":l.angle,"line":l.line,"raw":&text[l.start..l.end],"legacySuffix":l.legacy})
}
