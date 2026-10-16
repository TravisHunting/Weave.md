---
name: author-knowledge
description: Create or amend Weave Markdown articles and filepath relationships from supplied domain information. Use for knowledge authoring and lineage documentation, not reader UI development.
---

# Author Weave knowledge

Read AGENTS.md and docs/AUTHORING.md. Inspect the selected library and related articles before changing them. Knowledge lives in ordinary Markdown; graph and search indexes can be rebuilt from it. Work in the user-selected library, such as `knowledge-example/`, without assuming its name is `knowledge` or making articles depend on the app repository.

## Write useful articles

Use one article per meaningful subject, a readable filename, and a first-line Markdown heading. Explain what it is, its role, specific connections, and relevant limits. Favor rich prose and a few useful references over a node for every incidental detail. Retain exact identifiers in inline code, for example `dbo.fact_orders` or `ls_sql_warehouse_prd`.

An OKF frontmatter `title` supplies the file-tree, graph and link title when present; otherwise the first body-line heading (# through ######) does, with filename fallback. Although optional syntax, it is important to the reader UX: meaningful titles mask technical filenames so paths and incoming links can stay stable. Weave creates this heading from the filename for new articles. Prefer editing the heading over renaming the file when only the visible title needs to change. The immediate parent folder supplies category/color; root articles use the workspace folder. Folders organize browsing. Each indexed workspace is a separate search collection; links resolve within it.

Overview articles are ordinary Markdown linking representative subjects and nested overviews. They need no special metadata. Preserve real-world identities during moves and update incoming links. Use readable filenames without appended IDs and check for collisions.

## Links and relationships

Use OKF Markdown links with paths relative to the current article, starting with `./` or `../`, forward slashes and `.md`. For an article at `databases/reporting-database.md`:

```markdown
# Reporting database

The reporting database stores processed policy and claim data. It is hosted on
[Reporting server](../infrastructure/servers/reporting-server.md "hosted-in").
The nightly [Policy loader](../pipelines/policy-loader.md "loaded-by") refreshes its data;
configuration alone does not establish that the latest run succeeded.

See [Reporting operations](../guides/reporting-operations.md) for the operating procedure.

Tags: SQL, reporting, operations.
```

The example targets must exist. Do not use filesystem paths or invent targets. Weave also reads OKF bundle-relative paths that start with `/` (from the workspace root), but relative paths work in every Markdown reader and are the authoring convention. Wrap a path containing spaces in angle brackets: `[Data Platform](<../teams/Data Platform.md>)`.

An untyped `[Label](./article.md)` creates `links-to`. A typed link puts the relationship in the standard link title: `[Label](./article.md "relationship")`. Use letters, numbers, underscores or hyphens in the relationship name, without spaces; a longer title is just a tooltip. The label is displayed to readers: use the target article's title unless the sentence reads better otherwise, and escape `[`, `]` or `|` in it with a backslash. Do not use `[[...]]` wiki links, `)@@type` suffixes, `entity:` URLs, IDs or separate relationship records. Relationship titles are hidden in ordinary reading and visible in editing/source. OKF expresses relationships in prose, so the sentence must explain the connection too.

Direction runs from the current article to the target. Put the typed link directly in the main prose or the relevant workflow step, and explain the connection there. Do not append a relationship footer, `See [...](... "type")` records, or generic “This is a … connection” sentences. A Topics/Tags line may remain at the bottom. When integrating existing relationship records, preserve their type, direction, factual description and qualifications, then remove duplicate wording. In activity lists, attach an invocation to the activity that makes the call, not to an unrelated failure dependency. Keep these meanings distinct:

- Data lineage: `reads-from`, `writes-to`, `transforms`. Name omitted intermediate mechanisms; do not claim direct copying where only a broader path is established.
- Execution: `triggers`, `invokes`. Scheduling and execution order do not themselves establish lineage.
- Structure: `hosted-in`, `contains`, `part-of`.
- Dependency: `depends-on`, `uses`, `documented-by`.

The vocabulary is open; reuse established readable types when their meaning fits. Do not add redundant inverse links or infer a connection from proximity. Preserve descriptions, inactive/historical status and unknowns in prose. Connections/backlinks are calculated; do not author a generated `## Connections` section.

## Tags and external resources

Use an ordinary `Tags: API, SQL, ETL` or `Topics: API, SQL, ETL.` line. Both are equivalent; trailing periods are ignored. Put the three most useful tags first for the graph. Preserve useful tags and avoid inferring ownership from a mention. Do not add trailing YAML metadata, entity IDs, category fields or status blocks; frontmatter belongs only at the start of the article.

## OKF frontmatter

Give every article you create Open Knowledge Format frontmatter, and add it when you substantially edit an article that has none. It is the machine-readable identity agents and OKF tools rely on, and Weave shows it as property pills. Preserve existing frontmatter, including keys Weave does not use, comments and key order. Fill in what the sources support:

- `type` (required, non-empty): the kind of subject in a few words, such as `Database`, `Server`, `Pipeline`, `Team`, `Process` or `Overview`. Reuse the types already used in the library for the same kind of subject; use `Note` only when nothing more specific fits.
- `title`: the display title, the same as the first-line heading.
- `description`: one factual sentence saying what the subject is or does. Leave it out rather than guess.
- `resource`: the canonical URI of the real asset (a console page, repository or documentation URL) when the sources give one. Never include credentials, signed URL parameters or personal data, and never invent one.
- `tags`: a YAML flow list, `[a, b]`, of the most useful topics first. When the article also has a `Tags:` line, keep the two consistent.
- `created_at` and `updated_at`: ISO 8601 timestamps with an offset, such as `2026-10-07T14:03:22+13:00`. Set both when you create an article; on every later edit refresh `updated_at` and keep `created_at`. Weave maintains them itself when an article is saved in the app; they have no property pills.

Do not add `authors`, IDs, relationship blocks or other invented metadata. A frontmatter `title` overrides the heading as the display title, so keep the two consistent:

```markdown
---
type: Database
title: Reporting database
description: Processed policy and claim data for reporting.
tags: [SQL, reporting]
created_at: 2026-10-07T14:03:22+13:00
updated_at: 2026-10-07T14:03:22+13:00
---
# Reporting database
```

Use regular Markdown HTTP(S) links for external resources: `[Resource name](https://example.com/resource)`. These do not create graph edges. Exclude credentials, signed URL parameters and personal data. Code fences and inline code can illustrate syntax; their links are not indexed.

## Interpret sources carefully

Inspect only supplied or authorized sources. Preserve exact cloud, server, database and application identities. Never invent schemas, parameterized databases or missing mappings. Distinguish confirmed facts, inference, unknowns and historical configuration. Preserve domain facts during format changes.

For SQL/ETL, inspect active definitions rather than comments alone, distinguish views from tables, resolve configuration to concrete hosts/databases, and separate orchestration from data movement. A configured call is not proof of execution. A loop is not proof of numeric ordering without explicit ordering. Summarize behavior instead of publishing raw SQL or export paths. Never change live infrastructure; live read-only inventory requires explicit authorization.

## Validate and deliver

After every article edit, validate the changed files or containing folder:

```powershell
.\.agents\scripts\Validate-Knowledge.ps1 -KnowledgeRoot knowledge-example -Path knowledge-example\infrastructure
.\.agents\scripts\Validate-Knowledge.ps1 -KnowledgeRoot knowledge-example
node scripts/validate-weave.mjs knowledge-example
```

The PowerShell checker works on 5.1+ without external modules. It checks fences, Markdown article-link structure, that targets exist and are written relative to the article, relationship titles, wiki links and `@@` suffixes, and OKF frontmatter closure and `type`; it does not judge domain truth or require metadata. The Node checker also enforces repository conventions. Fix errors and rerun before delivery. Mention unresolved factual limits. For UI/build changes, follow AGENTS.md verification. Do not commit, publish or upload unless asked.
