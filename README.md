# mcp-api-football

API-Football MCP — comprehensive soccer/football data

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 965+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `standings` | Current standings table for a league. Returns rank, team, points, goal difference, form. Use league=1 for World Cup. |
| `team_search` | Look up a team by name + country to get its team_id for use in other tools. |
| `league_search` | Look up a league/tournament/competition by name to get its league_id. |
| `predictions` | API-Football\'s own match-outcome predictions. Returns home/draw/away win probabilities, advice, h2h context, form. Use for "who will win" research on specific fixtures. |
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

Or connect to the full Pipeworx gateway for access to all 965+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Api Football data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [All tools and guides](https://github.com/pipeworx-io/examples)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
