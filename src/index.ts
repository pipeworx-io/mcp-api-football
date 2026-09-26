interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
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


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'API-Football');
}

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
function missingKeyResponse(tool: string): { found: false; reason: 'missing_api_key'; tool: string; hint: string; register_url: string } {
  return {
    found: false,
    reason: 'missing_api_key',
    tool,
    hint: 'API-Football requires an API key: pass your key as the _apiKey argument. Free tier provides 100 calls/day.',
    register_url: 'https://dashboard.api-football.com/register',
  };
}

type ApiFootballSoftFail =
  | { found: false; reason: 'rate_limit'; window: 'minute' | 'day'; hint: string; retry_after_sec: number }
  | { found: false; reason: 'auth_failed'; hint: string }
  | { found: false; reason: 'paid_plan_required'; hint: string; allowed_seasons: string | null }
  | { found: false; reason: 'upstream_error'; hint: string; retry_after_sec: number | null };

const MINUTE_LIMIT = /per minute|requests? per min/i;
const ANY_LIMIT = /too many requests|request limit|rate ?limit|exceeded the limit/i;

function secondsToUtcMidnight(nowMs: number): number {
  return Math.max(60, 86400 - Math.floor((nowMs / 1000) % 86400));
}

// API-Football reports a throttle in TWO ways: an HTTP 429, and — more often —
// an HTTP 200 whose body carries `errors: {rateLimit: "Too many requests. You
// have exceeded the limit of requests per minute of your subscription."}`.
// The second one fell through to `upstream_error` with retry_after_sec:null, so
// a caller told "retry in a minute" was instead told the source was broken
// (fleet #2447). The two windows need different hints: a per-minute throttle
// clears in ~60s, a daily one at the UTC reset.
export function rateLimitSoftFail(message: string, retryAfterHeader: string | null, nowMs: number): ApiFootballSoftFail {
  const perMinute = MINUTE_LIMIT.test(message) || !/day|daily/i.test(message);
  const headerSec = retryAfterHeader != null && /^\d+$/.test(retryAfterHeader.trim()) ? Number(retryAfterHeader.trim()) : null;
  const retry = headerSec ?? (perMinute ? 60 : secondsToUtcMidnight(nowMs));
  return {
    found: false,
    reason: 'rate_limit',
    window: perMinute ? 'minute' : 'day',
    hint: perMinute
      ? `API-Football per-minute rate limit hit; retry in about ${retry}s. (${message.slice(0, 160)})`
      : `API-Football daily request quota exhausted; it resets at 00:00 UTC (in ~${retry}s). (${message.slice(0, 160)})`,
    retry_after_sec: retry,
  };
}

// Classify a parsed API-Football body. Returns null when the body is a normal
// answer. Pure so the RED/GREEN cases are unit-testable without the network.
export function classifyApiFootballBody(
  data: { errors?: Record<string, string> | string[] },
  retryAfterHeader: string | null,
  nowMs: number,
): ApiFootballSoftFail | null {
  if (!data.errors || Object.keys(data.errors).length === 0) return null;
  const msgs = Array.isArray(data.errors) ? data.errors : Object.values(data.errors);
  const joined = msgs.join('; ');
  const keys = Array.isArray(data.errors) ? [] : Object.keys(data.errors);
  if (keys.includes('rateLimit') || keys.includes('requests') || ANY_LIMIT.test(joined)) {
    return rateLimitSoftFail(joined, retryAfterHeader, nowMs);
  }
  // The FREE plan (a BYO free key) blocks seasons outside a window the vendor
  // names in the error itself — "...try from 2022 to 2024." The window moves
  // every year, so it is read from that message rather than hard-coded; the
  // hard-coded "2022-2024" had gone stale (fleet #2447). This branch fires only
  // on the vendor's own plan error: the platform key is on a paid plan and
  // answers current seasons (live 2026-09-26: EPL 2026 and 2025 standings).
  if (/Free plans? do not have access/i.test(joined)) {
    const m = joined.match(/from\s+(\d{4})\s+to\s+(\d{4})/i);
    const window = m ? `${m[1]}-${m[2]}` : null;
    return {
      found: false,
      reason: 'paid_plan_required',
      hint: `API-Football free plan blocks this query: ${joined.slice(0, 200)}${window ? ` Free plans can query seasons ${window}; a paid API-Football plan covers the current season.` : ''}`,
      allowed_seasons: window,
    };
  }
  return {
    found: false,
    reason: 'upstream_error',
    hint: `API-Football: ${joined.slice(0, 200)}`,
    retry_after_sec: null,
  };
}

async function apiGet(path: string, params: Record<string, string | number | undefined>, apiKey: string): Promise<unknown | ApiFootballSoftFail> {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  const res = await pwFetch(url.toString(), { headers: headers(apiKey) });
  if (res.status === 429) {
    const body = (await res.text().catch(() => '')).slice(0, 400);
    return rateLimitSoftFail(body || 'HTTP 429 Too many requests', res.headers.get('retry-after'), Date.now());
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
  const soft = classifyApiFootballBody(data, res.headers.get('retry-after'), Date.now());
  if (soft) return soft;
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
    name: 'football_injuries',
    description:
      'Currently injured and unavailable football players for a club or a league — who is out, the injury or reason, and whether they are ruled out or merely doubtful. Covers Serie A, the Premier League, La Liga, the Bundesliga, Ligue 1 and other competitions worldwide. Use for questions about which players are injured, unavailable, or missing from a squad.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        team: { type: 'string', description: 'Club name, e.g. "AC Milan". Resolved to its team id for you.' },
        league: { type: 'number', description: 'League id instead of a team — use league_search to find one.' },
        season: { type: 'number', description: 'Season start year, e.g. 2025. Defaults to the current season.' },
        _apiKey: { type: 'string', description: 'BYO API-Football key (https://dashboard.api-football.com/register)' },
      },
    },
  },
  {
    name: 'football_squad',
    description:
      'The current player squad for a football club — every player with shirt number, position, age and nationality. Use for questions about who plays for a club, squad lists, and a team roster.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        team: { type: 'string', description: 'Club name, e.g. "AC Milan". Resolved to its team id for you.' },
        _apiKey: { type: 'string', description: 'BYO API-Football key.' },
      },
      required: ['team'],
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
    case 'football_injuries':
    case 'football_squad': {
      // Callers say "AC Milan", the vendor wants a numeric team id. Resolving
      // here costs one extra request but is the difference between a usable
      // tool and one that requires an id nobody has.
      let teamId: number | undefined;
      if (typeof args.team === 'string' && args.team.trim()) {
        const found = await apiGet('/teams', { search: args.team.trim() }, apiKey);
        if ((found as { found?: boolean }).found === false) return found;
        const first = (Array.isArray(found) ? found : [])[0] as { team?: { id?: number; name?: string } } | undefined;
        if (!first?.team?.id) {
          return {
            found: false,
            reason: 'team_not_found',
            team_requested: args.team,
            hint: 'Use team_search to find the club as API-Football spells it.',
          };
        }
        teamId = first.team.id;
      }

      if (name === 'football_squad') {
        if (!teamId) return { found: false, reason: 'missing_team', hint: 'Give a club name.' };
        const data = await apiGet('/players/squads', { team: teamId }, apiKey);
        if ((data as { found?: boolean }).found === false) return data;
        const squad = (Array.isArray(data) ? data : [])[0] as
          | { team?: { name?: string }; players?: Record<string, unknown>[] }
          | undefined;
        const players = squad?.players ?? [];
        return {
          found: players.length > 0,
          team: squad?.team?.name ?? args.team,
          team_id: teamId,
          count: players.length,
          players,
          ...(players.length ? {} : { reason: 'no_squad_data', hint: 'The club resolved but the vendor returned no squad for it.' }),
          source: 'API-Football',
        };
      }

      if (!teamId && !args.league) {
        return { found: false, reason: 'missing_target', hint: 'Give a club name in `team`, or a league id in `league`.' };
      }
      const params: Record<string, string | number | undefined> = {
        season: Number(args.season) || new Date().getUTCFullYear(),
      };
      if (teamId) params.team = teamId;
      if (args.league) params.league = Number(args.league);
      const data = await apiGet('/injuries', params, apiKey);
      if ((data as { found?: boolean }).found === false) return data;
      const rows = (Array.isArray(data) ? data : []) as {
        player?: { name?: string; type?: string; reason?: string };
        team?: { name?: string };
        fixture?: { date?: string };
      }[];
      return {
        found: rows.length > 0,
        team: rows[0]?.team?.name ?? (teamId ? args.team : null),
        season: params.season,
        count: rows.length,
        injuries: rows.map((r) => ({
          player: r.player?.name ?? null,
          status: r.player?.type ?? null,
          reason: r.player?.reason ?? null,
          team: r.team?.name ?? null,
          as_of_fixture: r.fixture?.date ?? null,
        })),
        ...(rows.length
          ? {}
          : {
              reason: 'no_injuries_reported',
              hint: 'API-Football reports injuries per fixture, so an empty result usually means no upcoming fixture has a reported absence — not that the squad is fully fit.',
            }),
        source: 'API-Football',
      };
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
