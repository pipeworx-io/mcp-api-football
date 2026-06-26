interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * API-Football MCP — comprehensive soccer/football data
 *
 * BYO key (free tier 100/day) — sign up at https://www.api-football.com/
 * or via RapidAPI. Pass via the `_apiKey` argument. Platform-key support
 * via PLATFORM_API_FOOTBALL_KEY env var on the gateway.
 *
 * This is the bet_research lever for the FIFA World Cup category (top
 * Polymarket vol category alongside Iran geopolitics). Without this pack
 * the bet_research routing for sports falls back to news context only.
 *
 * Tools:
 * - fixtures:       upcoming + recent matches by league/team/date
 * - standings:      league standings table
 * - team_search:    look up team_id by name / country
 * - league_search:  look up league_id (e.g. World Cup = 1, EPL = 39)
 * - predictions:    API-Football's own match-outcome probabilities
 * - h2h:            head-to-head record between two teams
 */


const BASE_URL = 'https://v3.football.api-sports.io';

function headers(key: string): Record<string, string> {
  return {
    'x-apisports-key': key,
    Accept: 'application/json',
  };
}

function resolveKey(args: Record<string, unknown>): string | null {
  const key = (args._apiKey as string | undefined)?.trim();
  return key && key.length > 0 ? key : null;
}

// Soft-fail envelope when no API key is configured. Returned in place of
// throwing so callers can branch on a structured shape rather than parsing
// a truncated error string out of sources_failed (Run 7B audit asked for
// explicit team_row:null + reason:"API_FOOTBALL_KEY missing" instead of
// silent failure).
function missingKeyResponse(tool: string): { found: false; reason: 'missing_api_key'; tool: string; hint: string; register_url: string; platform_env_var: string } {
  return {
    found: false,
    reason: 'missing_api_key',
    tool,
    hint: 'No API-Football key configured. The gateway operator has not set PLATFORM_API_FOOTBALL_KEY; callers can pass their own via the _apiKey arg. Free tier provides 100 calls/day.',
    register_url: 'https://dashboard.api-football.com/register',
    platform_env_var: 'PLATFORM_API_FOOTBALL_KEY',
  };
}

type ApiFootballSoftFail =
  | { found: false; reason: 'rate_limit'; hint: string; retry_after_sec: number }
  | { found: false; reason: 'auth_failed'; hint: string }
  | { found: false; reason: 'paid_plan_required'; hint: string; allowed_seasons: string }
  | { found: false; reason: 'upstream_error'; hint: string; retry_after_sec: number | null };

async function apiGet(path: string, params: Record<string, string | number | undefined>, apiKey: string): Promise<unknown | ApiFootballSoftFail> {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), { headers: headers(apiKey) });
  if (res.status === 429) {
    return {
      found: false,
      reason: 'rate_limit',
      hint: 'API-Football daily rate limit hit (free tier = 100 calls/day). Wait until the daily UTC reset or upgrade.',
      retry_after_sec: Math.max(60, 86400 - Math.floor((Date.now() / 1000) % 86400)),
    };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      found: false,
      reason: 'auth_failed',
      hint: `API-Football auth failed (${res.status}). Verify _apiKey is a valid api-football.com key (not a RapidAPI key — different header).`,
    };
  }
  if (!res.ok) {
    return {
      found: false,
      reason: 'upstream_error',
      hint: `API-Football ${res.status}: ${(await res.text()).slice(0, 200)}`,
      retry_after_sec: res.status >= 500 ? 15 : null,
    };
  }
  const data = (await res.json()) as { errors?: Record<string, string> | string[]; response?: unknown };
  if (data.errors && Object.keys(data.errors).length > 0) {
    const msgs = Array.isArray(data.errors) ? data.errors : Object.values(data.errors);
    const joined = msgs.join('; ');
    // API-Football's free plan blocks current/future seasons with this
    // exact error string. Recognize it as a structured paid-plan-required
    // signal so callers can switch to an allowed-season query or skip.
    if (/Free plans do not have access/i.test(joined)) {
      return {
        found: false,
        reason: 'paid_plan_required',
        hint: `API-Football free plan blocks this query: ${joined.slice(0, 200)}`,
        allowed_seasons: '2022-2024',
      };
    }
    return {
      found: false,
      reason: 'upstream_error',
      hint: `API-Football: ${joined.slice(0, 200)}`,
      retry_after_sec: null,
    };
  }
  return data.response ?? data;
}

const tools: McpToolExport['tools'] = [
  {
    name: 'fixtures',
    description:
      'Get match fixtures (upcoming + recent) by league, team, or date. Use league=1 for FIFA World Cup, league=39 for EPL, league=140 for La Liga. Returns kickoff, teams, score (if played), venue, status.',
    inputSchema: {
      type: 'object',
      properties: {
        league: { type: 'number', description: 'League ID (1 = FIFA World Cup, 39 = EPL, 140 = La Liga, 2 = Champions League — use league_search to find others)' },
        team: { type: 'number', description: 'Team ID — use team_search to find' },
        date: { type: 'string', description: 'YYYY-MM-DD — single-day fixtures' },
        season: { type: 'number', description: 'Season year (e.g. 2026)' },
        last: { type: 'number', description: 'Last N played matches for the team/league' },
        next: { type: 'number', description: 'Next N upcoming matches for the team/league' },
        _apiKey: { type: 'string', description: 'BYO API-Football key (https://dashboard.api-football.com/register)' },
      },
    },
  },
  {
    name: 'standings',
    description: 'Current standings table for a league. Returns rank, team, points, goal difference, form. Use league=1 for World Cup.',
    inputSchema: {
      type: 'object',
      properties: {
        league: { type: 'number', description: 'League ID (required)' },
        season: { type: 'number', description: 'Season year (required, e.g. 2026)' },
        _apiKey: { type: 'string' },
      },
      required: ['league', 'season'],
    },
  },
  {
    name: 'team_search',
    description: 'Look up a team by name + country to get its team_id for use in other tools.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Team name (e.g. "France", "Real Madrid")' },
        country: { type: 'string', description: 'Country name to disambiguate' },
        _apiKey: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'league_search',
    description: 'Look up a league/tournament/competition by name to get its league_id.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Competition name (e.g. "World Cup", "Champions League", "Premier League")' },
        country: { type: 'string', description: 'Country name to filter' },
        _apiKey: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'predictions',
    description: 'API-Football\'s own match-outcome predictions. Returns home/draw/away win probabilities, advice, h2h context, form. Use for "who will win" research on specific fixtures.',
    inputSchema: {
      type: 'object',
      properties: {
        fixture: { type: 'number', description: 'Fixture ID — get from fixtures() output' },
        _apiKey: { type: 'string' },
      },
      required: ['fixture'],
    },
  },
  {
    name: 'h2h',
    description: 'Head-to-head record between two teams. Returns last N matches with scores.',
    inputSchema: {
      type: 'object',
      properties: {
        team1: { type: 'number', description: 'First team ID' },
        team2: { type: 'number', description: 'Second team ID' },
        last: { type: 'number', description: 'Last N H2H matches (default 5)' },
        _apiKey: { type: 'string' },
      },
      required: ['team1', 'team2'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const apiKey = resolveKey(args);
  if (!apiKey) return missingKeyResponse(name);
  switch (name) {
    case 'fixtures': {
      const params: Record<string, string | number | undefined> = {
        league: args.league as number | undefined,
        team: args.team as number | undefined,
        date: args.date as string | undefined,
        season: args.season as number | undefined,
        last: args.last as number | undefined,
        next: args.next as number | undefined,
      };
      const data = await apiGet('/fixtures', params, apiKey);
      if ((data as { found?: boolean }).found === false) return data;
      const arr = Array.isArray(data) ? data : [];
      return {
        count: arr.length,
        fixtures: arr.slice(0, 50).map(projectFixture),
      };
    }
    case 'standings': {
      const data = await apiGet('/standings', {
        league: args.league as number,
        season: args.season as number,
      }, apiKey);
      if ((data as { found?: boolean }).found === false) return data;
      const arr = Array.isArray(data) ? data : [];
      const league = arr[0] as { league?: { standings?: Array<Array<Record<string, unknown>>> } } | undefined;
      const groups = league?.league?.standings ?? [];
      return {
        league_id: args.league,
        season: args.season,
        groups: groups.map((group) => group.map(projectStanding)),
      };
    }
    case 'team_search': {
      const data = await apiGet('/teams', {
        search: args.name as string,
        country: args.country as string | undefined,
      }, apiKey);
      if ((data as { found?: boolean }).found === false) return data;
      const arr = Array.isArray(data) ? data : [];
      return {
        count: arr.length,
        teams: arr.slice(0, 20).map((t: unknown) => projectTeam(t as Record<string, unknown>)),
      };
    }
    case 'league_search': {
      const data = await apiGet('/leagues', {
        search: args.name as string,
        country: args.country as string | undefined,
      }, apiKey);
      if ((data as { found?: boolean }).found === false) return data;
      const arr = Array.isArray(data) ? data : [];
      return {
        count: arr.length,
        leagues: arr.slice(0, 20).map((l: unknown) => projectLeague(l as Record<string, unknown>)),
      };
    }
    case 'predictions': {
      const data = await apiGet('/predictions', { fixture: args.fixture as number }, apiKey);
      if ((data as { found?: boolean }).found === false) return data;
      const arr = Array.isArray(data) ? data : [];
      return arr[0] ?? null;
    }
    case 'h2h': {
      const data = await apiGet('/fixtures/headtohead', {
        h2h: `${args.team1}-${args.team2}`,
        last: (args.last as number | undefined) ?? 5,
      }, apiKey);
      if ((data as { found?: boolean }).found === false) return data;
      const arr = Array.isArray(data) ? data : [];
      return {
        count: arr.length,
        matches: arr.slice(0, 20).map(projectFixture),
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function projectFixture(raw: unknown) {
  const r = raw as {
    fixture?: { id: number; date: string; status?: { short?: string }; venue?: { name?: string } };
    league?: { name?: string; round?: string };
    teams?: { home?: { id?: number; name?: string }; away?: { id?: number; name?: string } };
    goals?: { home?: number | null; away?: number | null };
  };
  return {
    fixture_id: r.fixture?.id,
    date: r.fixture?.date,
    status: r.fixture?.status?.short,
    venue: r.fixture?.venue?.name,
    league: r.league?.name,
    round: r.league?.round,
    home: r.teams?.home?.name,
    away: r.teams?.away?.name,
    home_team_id: r.teams?.home?.id,
    away_team_id: r.teams?.away?.id,
    score_home: r.goals?.home,
    score_away: r.goals?.away,
  };
}

function projectStanding(raw: Record<string, unknown>) {
  const r = raw as {
    rank?: number;
    team?: { id?: number; name?: string };
    points?: number;
    goalsDiff?: number;
    form?: string;
    all?: { played?: number; win?: number; draw?: number; lose?: number };
  };
  return {
    rank: r.rank,
    team: r.team?.name,
    team_id: r.team?.id,
    points: r.points,
    goal_diff: r.goalsDiff,
    form: r.form,
    played: r.all?.played,
    won: r.all?.win,
    drawn: r.all?.draw,
    lost: r.all?.lose,
  };
}

function projectTeam(raw: Record<string, unknown>) {
  const r = raw as {
    team?: { id?: number; name?: string; country?: string; founded?: number };
    venue?: { name?: string; city?: string; capacity?: number };
  };
  return {
    id: r.team?.id,
    name: r.team?.name,
    country: r.team?.country,
    founded: r.team?.founded,
    venue: r.venue?.name,
    city: r.venue?.city,
  };
}

function projectLeague(raw: Record<string, unknown>) {
  const r = raw as {
    league?: { id?: number; name?: string; type?: string };
    country?: { name?: string; code?: string };
    seasons?: Array<{ year?: number; current?: boolean }>;
  };
  return {
    id: r.league?.id,
    name: r.league?.name,
    type: r.league?.type,
    country: r.country?.name,
    seasons: r.seasons?.filter((s) => s.current).map((s) => s.year),
  };
}

export default { tools, callTool, meter: { credits: 2 } } satisfies McpToolExport;
