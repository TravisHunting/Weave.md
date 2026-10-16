//! Graph neighbourhoods streamed by depth. The traversal visits only the
//! selected articles' links, read from the index on demand, so its cost is
//! proportional to the neighbourhood shown, never to the workspace.
use crate::{
    database::{broken, edge_json, edges_on, Database},
    index::name_key,
    native_files::{err, Result},
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

/// Links of one article, at most this many per direction.
const MAX_EDGES: usize = 5000;
pub struct Edge {
    pub id: String,
    pub from: String,
    pub to: String,
    /// Snapshot order: source path, then source offset.
    pub order: (String, i64),
    pub value: Value,
}
/// Where a traversal reads nodes and links.
pub trait Source {
    fn node(&mut self, id: &str) -> Result<Option<Value>>;
    /// Every link touching `id`, sorted by link id.
    fn adjacent(&mut self, id: &str) -> Result<Vec<Edge>>;
}
/// The index of one workspace, read within one transaction.
pub struct Index<'a> {
    pub db: &'a Connection,
    pub workspace: &'a str,
    broken: HashMap<String, Value>,
    exists: HashMap<String, bool>,
}
impl<'a> Index<'a> {
    pub fn new(db: &'a Connection, workspace: &'a str) -> Self {
        Self {
            db,
            workspace,
            broken: HashMap::new(),
            exists: HashMap::new(),
        }
    }
    fn exists(&mut self, id: &str) -> Result<bool> {
        if id.starts_with("broken:") {
            return Ok(true);
        }
        if let Some(&known) = self.exists.get(id) {
            return Ok(known);
        }
        let found: bool = self
            .db
            .prepare_cached("SELECT EXISTS(SELECT 1 FROM documents WHERE workspace=? AND path=?)")
            .map_err(err)?
            .query_row(params![self.workspace, id], |r| r.get(0))
            .map_err(err)?;
        self.exists.insert(id.to_string(), found);
        Ok(found)
    }
    fn edge(&mut self, mut value: Value) -> Edge {
        let to = edge_json(&mut value);
        if to.starts_with("broken:") && !self.broken.contains_key(&to) {
            self.broken.insert(to.clone(), broken(&to, &value));
        }
        let from = value["from"].as_str().unwrap_or("").to_string();
        Edge {
            id: value["id"].as_str().unwrap_or("").to_string(),
            order: (from.clone(), value["start_offset"].as_i64().unwrap_or(0)),
            from,
            to,
            value,
        }
    }
}
impl Source for Index<'_> {
    fn node(&mut self, id: &str) -> Result<Option<Value>> {
        if id.starts_with("broken:") {
            if !self.broken.contains_key(id) {
                // A missing target is a node once some link names it.
                self.adjacent(id)?;
            }
            return Ok(self.broken.get(id).cloned());
        }
        Database::graph_nodes(self.db, self.workspace, id)
    }
    fn adjacent(&mut self, id: &str) -> Result<Vec<Edge>> {
        let mut records = vec![];
        if let Some(rest) = id.strip_prefix("broken:") {
            let target = rest.split_once(':').map_or("", |(_, t)| t);
            let mut stmt = self.db.prepare_cached("SELECT record FROM relationships INDEXED BY relationship_keys WHERE workspace=? AND target IS NULL AND target_key=? ORDER BY source,start").map_err(err)?;
            for r in stmt
                .query_map(params![self.workspace, name_key(target)], |r| {
                    r.get::<_, String>(0)
                })
                .map_err(err)?
            {
                records.push(serde_json::from_str::<Value>(&r.map_err(err)?).map_err(err)?);
            }
        } else {
            for incoming in [false, true] {
                let mut list = edges_on(self.db, self.workspace, Some(id), incoming)?;
                list.truncate(MAX_EDGES);
                records.extend(list);
            }
        }
        let mut seen = HashSet::new();
        let mut out = vec![];
        for record in records {
            let edge = self.edge(record);
            if (edge.from != id && edge.to != id) || !seen.insert(edge.id.clone()) {
                continue;
            }
            // Links to articles that could not be read have no node.
            if self.exists(&edge.from)? && self.exists(&edge.to)? {
                out.push(edge);
            }
        }
        out.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(out)
    }
}
/// A complete graph held in memory (tests and small snapshots).
pub struct Snapshot {
    nodes: HashMap<String, Value>,
    adjacent: HashMap<String, Vec<usize>>,
    edges: Vec<(String, String, Value)>,
}
impl Snapshot {
    pub fn new(snapshot: &Value) -> Self {
        let nodes: HashMap<String, Value> = snapshot["entities"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|n| Some((n["id"].as_str()?.to_string(), n.clone())))
            .collect();
        let mut adjacent: HashMap<String, Vec<usize>> = HashMap::new();
        let mut edges = vec![];
        for edge in snapshot["relationships"].as_array().into_iter().flatten() {
            let (Some(from), Some(to)) = (edge["from"].as_str(), edge["to"].as_str()) else {
                continue;
            };
            if !nodes.contains_key(from) || !nodes.contains_key(to) {
                continue;
            }
            adjacent
                .entry(from.to_string())
                .or_default()
                .push(edges.len());
            if from != to {
                adjacent
                    .entry(to.to_string())
                    .or_default()
                    .push(edges.len());
            }
            edges.push((from.to_string(), to.to_string(), edge.clone()));
        }
        Self {
            nodes,
            adjacent,
            edges,
        }
    }
}
impl Source for Snapshot {
    fn node(&mut self, id: &str) -> Result<Option<Value>> {
        Ok(self.nodes.get(id).cloned())
    }
    fn adjacent(&mut self, id: &str) -> Result<Vec<Edge>> {
        let mut out: Vec<Edge> = self
            .adjacent
            .get(id)
            .into_iter()
            .flatten()
            .map(|&i| {
                let (from, to, value) = &self.edges[i];
                Edge {
                    id: value["id"].as_str().unwrap_or("").to_string(),
                    from: from.clone(),
                    to: to.clone(),
                    order: (String::new(), i as i64),
                    value: value.clone(),
                }
            })
            .collect();
        out.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(out)
    }
}
/// A bounded BFS visits each selected node's links once. An edge is sent
/// only when both ends become visible; cycles and parallel links are retained.
pub fn stream(
    source: &mut dyn Source,
    scope: u64,
    revision: u64,
    args: &Value,
    mut send: impl FnMut(Value) -> Result<()>,
) -> Result<Value> {
    if args["scope"].as_u64() != Some(scope) {
        return Err("The graph changed. Refresh the workspace graph before navigating.".into());
    }
    let start = args["path"].as_str().unwrap_or("").to_string();
    let first = source
        .node(&start)?
        .ok_or("The graph article is no longer available.")?;
    let depth = args["depth"].as_u64().unwrap_or(1).clamp(1, 3) as usize;
    let limit = args["limit"].as_u64().unwrap_or(100).clamp(1, 100) as usize;
    let direction = args["direction"].as_str().unwrap_or("both");
    if !["both", "upstream", "downstream"].contains(&direction) {
        return Err("Unknown graph direction".into());
    }
    let mut values: HashMap<String, Value> = HashMap::from([(start.clone(), first)]);
    let mut links: HashMap<String, Vec<Edge>> = HashMap::new();
    fn adjacent(
        source: &mut dyn Source,
        links: &mut HashMap<String, Vec<Edge>>,
        id: &str,
    ) -> Result<()> {
        if !links.contains_key(id) {
            links.insert(id.to_string(), source.adjacent(id)?);
        }
        Ok(())
    }
    let mut selected: HashMap<String, usize> = HashMap::from([(start.clone(), 0)]);
    let mut frontier = vec![start.clone()];
    let mut sent_edges = HashSet::new();
    let mut truncated = false;
    let mut node_count = 0;
    let mut edge_count = 0;
    for layer in 1..=depth {
        let mut added = if layer == 1 {
            vec![start.clone()]
        } else {
            Vec::new()
        };
        let mut next_frontier = Vec::new();
        for current in &frontier {
            adjacent(source, &mut links, current)?;
            for edge in &links[current] {
                if direction == "downstream" && edge.from != *current
                    || direction == "upstream" && edge.to != *current
                {
                    continue;
                }
                let next = if edge.from == *current {
                    &edge.to
                } else {
                    &edge.from
                };
                if selected.contains_key(next) {
                    continue;
                }
                if selected.len() >= limit {
                    truncated = true;
                    continue;
                }
                selected.insert(next.clone(), layer);
                added.push(next.clone());
                next_frontier.push(next.clone());
            }
        }
        let mut added_edges: Vec<&Edge> = Vec::new();
        for node in &added {
            if !values.contains_key(node) {
                let value = source.node(node)?.unwrap_or_else(|| json!({"id":node}));
                values.insert(node.clone(), value);
            }
            adjacent(source, &mut links, node)?;
        }
        for node in &added {
            for edge in &links[node] {
                if selected.contains_key(&edge.from)
                    && selected.contains_key(&edge.to)
                    && sent_edges.insert(edge.id.clone())
                {
                    added_edges.push(edge);
                }
            }
        }
        added_edges.sort_by(|a, b| a.order.cmp(&b.order));
        let complete = layer == depth || next_frontier.is_empty() || truncated;
        node_count += added.len();
        edge_count += added_edges.len();
        send(json!({
            "requestId": args["requestId"], "scope": scope, "revision": revision,
            "depth": layer, "nodes": added.iter().map(|id| &values[id]).collect::<Vec<_>>(),
            "edges": added_edges.iter().map(|e| &e.value).collect::<Vec<_>>(),
            "distances": added.iter().map(|id| json!([id, selected[id]])).collect::<Vec<_>>(),
            "truncated": truncated, "complete": complete
        }))?;
        if complete {
            break;
        }
        frontier = next_frontier;
    }
    Ok(json!({"nodes": node_count, "edges": edge_count, "truncated": truncated}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Snapshot {
        Snapshot::new(
            &json!({"revision":7,"entities":[{"id":"a"},{"id":"b"},{"id":"c"},{"id":"d"}],
            "relationships":[{"id":"ab","from":"a","to":"b"},{"id":"bc","from":"b","to":"c"},
            {"id":"cd","from":"c","to":"d"},{"id":"ba","from":"b","to":"a"},{"id":"bb","from":"b","to":"b"}]}),
        )
    }
    fn request() -> Value {
        json!({"scope":4,"revision":7,"path":"a","depth":3,"direction":"downstream","requestId":"test"})
    }
    #[test]
    fn emits_depth_deltas_once_including_cycles_and_self_edges() {
        let mut chunks = Vec::new();
        let result = stream(&mut fixture(), 4, 7, &request(), |v| {
            chunks.push(v);
            Ok(())
        })
        .unwrap();
        assert_eq!(result["nodes"], 4);
        assert_eq!(result["edges"], 5);
        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks[0]["nodes"].as_array().unwrap().len(), 2);
        assert_eq!(chunks[1]["distances"], json!([["c", 2]]));
        assert_eq!(chunks[2]["complete"], true);
    }
    #[test]
    fn respects_direction_limit_and_rejects_another_workspace() {
        let mut graph = fixture();
        let mut args = request();
        args["direction"] = json!("upstream");
        args["path"] = json!("c");
        let result = stream(&mut graph, 4, 7, &args, |_| Ok(())).unwrap();
        assert_eq!(result["nodes"], 3);
        args["limit"] = json!(2);
        let result = stream(&mut graph, 4, 7, &args, |_| Ok(())).unwrap();
        assert_eq!(result["nodes"], 2);
        assert_eq!(result["truncated"], true);
        args["scope"] = json!(3);
        assert!(stream(&mut graph, 4, 7, &args, |_| Ok(())).is_err());
        args["scope"] = json!(4);
        args["path"] = json!("missing");
        assert!(stream(&mut graph, 4, 7, &args, |_| Ok(())).is_err());
    }
    #[test]
    fn transport_cancellation_stops_the_next_layer() {
        let mut chunks = 0;
        let result = stream(&mut fixture(), 4, 7, &request(), |_| {
            chunks += 1;
            Err("closed channel".into())
        });
        assert!(result.is_err());
        assert_eq!(chunks, 1);
    }
}
