# Authoring format

Weave reads ordinary [Open Knowledge Format](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md) Markdown. Nothing here is Weave-only syntax: a library written this way reads correctly in GitHub, VS Code, Obsidian and OKF-aware tools. [AGENTS.md](../AGENTS.md) and `.agents/skills/author-knowledge/SKILL.md` hold the fuller conventions for people and agents writing knowledge.

## Links

```text
[Azure Data Factory](../systems/azure-data-factory.md "writes-to")
[Snowflake](./snowflake.md "depends-on")
[Data Platform team](<../teams/Data Platform.md>)
[Overview](/overview.md)
```

- Write paths relative to the linking article, starting with `./` or `../`, with forward slashes and the `.md` extension. Wrap paths containing spaces in angle brackets.
- Weave also reads OKF bundle-relative paths starting with `/` (from the workspace root). A bare `systems/db.md` is tried relative to the article, then the root; the validators prefer `./` or `../`.
- The label is what readers see. An empty label `[]` shows the target's title.
- Missing or ambiguous targets stay visible as broken links. HTTP(S) links and links to other file types are ordinary links, not graph edges.
- Renaming or moving an article in Weave rewrites incoming links and the moved article's own links, keeping each link's relative or `/` form.

## Relationship types

Put a relationship name in the link title: `[Snowflake](./snowflake.md "depends-on")`. A title that is a single name (letters, numbers, hyphens or underscores) types the link; any other title is an ordinary tooltip, and untyped links mean `links-to`. The current article is the source and the target is the linked article.

The type is hidden while reading and shown while editing or in Source. OKF itself carries relationships in prose, so the sentence around the link should still explain the connection. Place typed links where the connection is explained, not in a list at the end.

When several links join the same pair of articles, the graph draws one arrow: a named relationship wins over `links-to`, and the first one authored in the active article supplies the label. Every link still appears in Connections and Deep search.

## Frontmatter

Articles may start with an OKF YAML block. `type` is required; `title`, `description`, `resource` and `tags` are the other core keys.

```yaml
---
type: BigQuery Table
title: Orders
description: One row per completed customer order.
resource: https://console.cloud.google.com/bigquery?p=acme&d=sales&t=orders
tags: [sales, revenue]
---
```

- A frontmatter `title` is the display title in Files, the graph and links; otherwise the first heading is, then the filename. Prefer changing a title over renaming a file.
- Weave shows frontmatter as editable property pills above the article. Unknown keys and comments are preserved.
- Saving in Weave sets `updated_at` and adds a missing `created_at` (the file's creation time), as local ISO 8601 times with an offset. An article saved without frontmatter gains `type: Note`. Articles never saved in Weave are left unchanged.

## Tags

`Tags: API, SQL` and `Topics: API, SQL.` at the bottom of an article mean the same thing; a trailing period is ignored and tags on several lines combine. Frontmatter `tags` come first. Graph nodes show the first three.

## Kanban boards

A board is any article with `type: Kanban Board`. Its ordered columns live in the board itself, each with a stable `id` and a displayed `title`:

```yaml
---
type: Kanban Board
title: Development Board
weave:
  kanban:
    columns:
      - id: backlog
        title: Backlog
      - id: in-progress
        title: In Progress
      - id: done
        title: Done
---
```

Any article becomes a card by naming the board in its own frontmatter. The article stays the card's content; nothing is copied elsewhere.

```yaml
weave:
  kanban:
    board: Development-Board.md   # the board's filename (or a ./, ../ or / path to it)
    column: in-progress           # a column id of that board
    rank: 2000                    # order within the column, lowest first
```

- Board filenames are unique among a workspace's boards, so a card keeps its board when the board moves between folders. Renaming a board updates the cards that name it.
- Moving a card writes only its `column` and `rank`, choosing a rank between its neighbours; only that column is renumbered when no room is left.
- Weave never infers boards from folders and never adds a column because a card names one. Cards it cannot place stay visible under **Needs attention**.

## Validating a library

```powershell
.\.agents\scripts\Validate-Knowledge.ps1 -KnowledgeRoot knowledge-example
node scripts/validate-weave.mjs knowledge-example
```

The first checks fences, link syntax and targets, relationship titles and frontmatter; the second adds the repository's authoring conventions using Weave's own parser.
