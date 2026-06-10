# Canolite Knowledge Graph

A prebuilt knowledge graph of this codebase, so you **don't have to build it yourself**.
Generated with [graphify](https://github.com/sponsors/safishamsi) (AST + LLM extraction,
Louvain community detection).

## Files

| File | What it's for |
|------|---------------|
| `graph.json` | The graph itself — **feed this to your AI model / GraphRAG pipeline**. Node-link JSON with `nodes`, `links`, `hyperedges`, and community assignments. |
| `graph.html` | Standalone interactive graph. Open in any browser — no server, no build step. |
| `GRAPH_REPORT.md` | Plain-language audit: god nodes, surprising connections, community breakdown, suggested questions. |

## Snapshot

- **517 nodes · 1,216 edges · 28 communities**
- Core communities: API Routes/DB Schema/Render Core, UI Components & Dashboard Pages,
  Deployment & Docker, Fonts & Image Rendering, Storage & Uploads, Self-Update System,
  SSRF Protection, Admin Auth, BullMQ Render Worker.
- All `source_file` paths are repo-relative.

## Using `graph.json` with an AI model

`graph.json` is plain node-link JSON — load it directly for retrieval-augmented generation:

```python
import json, networkx as nx
from networkx.readwrite import json_graph

data = json.load(open("graphify-out/graph.json"))
G = json_graph.node_link_graph(data)

# e.g. pull the neighborhood of a symbol to ground an LLM answer
ctx = list(G.neighbors("auth_getcurrentuser"))
```

Each node carries `label`, `file_type`, `source_file`, and a `community` id; each link
carries `relation` (`calls`, `implements`, `references`, `shares_data_with`,
`semantically_similar_to`, `rationale_for`, …) and a `confidence` tag
(`EXTRACTED` / `INFERRED` / `AMBIGUOUS`).

## Rebuilding (optional)

You only need this if the code changed and you want a fresh graph:

```
/graphify .            # in Claude Code, from the repo root
# or:  graphify extract .
```
