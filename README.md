# mcp-api-football

API-Football MCP — comprehensive soccer/football data

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1476+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `fixtures` | Get match fixtures (upcoming + recent) by league, team, or date. Use league=1 for FIFA World Cup, league=39 for EPL, league=140 for La Liga. Returns kickoff, teams, score (if played), venue, status. |
| `standings` | Current standings table for a league. Returns rank, team, points, goal difference, form. Use league=1 for World Cup. |
| `team_search` | Look up a team by name + country to get its team_id for use in other tools. |
| `league_search` | Look up a league/tournament/competition by name to get its league_id. |
| `predictions` | API-Football's own match-outcome predictions. Returns home/draw/away win probabilities, advice, h2h context, form. Use for "who will win" research on specific fixtures. |
| `football_injuries` | Currently injured and unavailable football players for a club or a league — who is out, the injury or reason, and whether they are ruled out or merely doubtful. Covers Serie A, the Premier League, La Liga, the Bundesliga, Ligue 1 and other competitions worldwide. Use for questions about which players are injured, unavailable, or missing from a squad. |
| `football_squad` | The current player squad for a football club — every player with shirt number, position, age and nationality. Use for questions about who plays for a club, squad lists, and a team roster. |
| `h2h` | Head-to-head record between two teams. Returns last N matches with scores. |

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "api-football": {
      "url": "https://gateway.pipeworx.io/api-football/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/api-football/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1476+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Api Football data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
