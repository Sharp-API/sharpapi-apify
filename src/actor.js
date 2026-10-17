// Core logic for the SharpAPI odds actor. Everything here takes its
// dependencies as arguments so the tests can drive it without the network
// or the Apify platform.

export const DEFAULT_SPORTSBOOKS = ['draftkings', 'fanduel']
export const DEFAULT_MAX_ITEMS = 1000
export const MARKET_TYPES = ['moneyline', 'spread', 'total']

// /odds accepts at most 500 rows per page.
export const PAGE_SIZE = 500

// 429 handling: wait 2 s, 4 s, 8 s, 16 s, 32 s, then give up.
export const MAX_RATE_LIMIT_RETRIES = 5
const BACKOFF_BASE_MS = 2000
const BACKOFF_CAP_MS = 60000

// The /odds fields copied into each dataset row, under the API's own names.
export const ROW_FIELDS = [
  'event_id',
  'sport',
  'league',
  'home_team',
  'away_team',
  'event_start_time',
  'sportsbook',
  'market_type',
  'selection',
  'line',
  'odds_american',
  'odds_decimal',
  'odds_probability',
  'is_live',
  'timestamp',
]

/** An error that ends the run. Its message is shown to the user as is. */
export class FatalError extends Error {}

/** Replace every copy of the API key in a string so it cannot reach a log. */
export function redact(text, apiKey) {
  const s = String(text ?? '')
  if (!apiKey) return s
  return s.split(apiKey).join('[redacted]')
}

/** Validate the raw actor input and fill in defaults. */
export function normalizeInput(raw) {
  const input = raw ?? {}
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : ''
  if (!apiKey) {
    throw new FatalError(
      'Add your SharpAPI key in the "SharpAPI key" field. The free SharpAPI plan covers DraftKings and FanDuel.',
    )
  }

  const books = Array.isArray(input.sportsbook) && input.sportsbook.length > 0
    ? input.sportsbook
    : DEFAULT_SPORTSBOOKS
  const sportsbooks = [...new Set(books.map((b) => String(b).trim().toLowerCase()).filter(Boolean))]

  const league = typeof input.league === 'string'
    ? input.league.split(',').map((l) => l.trim().toLowerCase()).filter(Boolean).join(',')
    : ''

  const marketType = typeof input.marketType === 'string' ? input.marketType.trim().toLowerCase() : ''
  if (marketType && !MARKET_TYPES.includes(marketType)) {
    throw new FatalError(`marketType must be one of ${MARKET_TYPES.join(', ')}, or empty for every market.`)
  }

  const maxItems = input.maxItems === undefined || input.maxItems === null
    ? DEFAULT_MAX_ITEMS
    : Number(input.maxItems)
  if (!Number.isInteger(maxItems) || maxItems < 1) {
    throw new FatalError('maxItems must be a whole number of 1 or more.')
  }

  return { apiKey, sportsbooks, league, marketType, liveOnly: input.liveOnly === true, maxItems }
}

/** The /odds query for one page of one sportsbook. */
export function buildQuery({ sportsbook, league, marketType, liveOnly, limit, cursor }) {
  const query = { sportsbook, limit }
  if (league) query.league = league
  if (marketType) query.market = marketType
  if (liveOnly) query.is_live = true
  if (cursor) query.cursor = cursor
  return query
}

/** One dataset row per price, keeping the field names /odds returns. */
export function toRow(odds) {
  const row = {}
  for (const field of ROW_FIELDS) row[field] = odds?.[field] ?? null
  return row
}

/** Run fn, waiting and retrying while SharpAPI answers 429. */
export async function withBackoff(fn, { sleep, log, maxRetries = MAX_RATE_LIMIT_RETRIES }) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (err?.status !== 429 || attempt >= maxRetries) throw err
      const delayMs = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS)
      log.warning(`SharpAPI rate limit reached (HTTP 429). Waiting ${delayMs / 1000} s before retrying.`)
      await sleep(delayMs)
    }
  }
}

function planTitle(tier) {
  return tier.charAt(0).toUpperCase() + tier.slice(1)
}

// Cut every http(s) address out of text we did not write, so a link in an
// API error can never reach a run message (Apify Store terms 2.2.4.2).
function withoutUrls(text) {
  return String(text).replace(/https?:\/\/\S+/gi, '').replace(/ {2,}/g, ' ').trim()
}

// Server messages usually end in a full stop; drop it so ours can follow.
function serverText(err) {
  return withoutUrls(err?.message ?? err).replace(/\.+$/, '')
}

function keyMessage(err) {
  return `SharpAPI did not accept the key (HTTP ${err.status}: ${serverText(err)}). `
    + 'Check your SharpAPI key: copy it again from your SharpAPI dashboard.'
}

/**
 * Decide what an API error means for one sportsbook. Returns a message when
 * that book should be skipped and the run should carry on; throws FatalError
 * when the whole run has to stop.
 */
export async function explainError(err, book, lookupPlan) {
  const status = err?.status
  const code = err?.code
  if (status === 401) throw new FatalError(keyMessage(err))
  if (status === 403 && code === 'tier_restricted') {
    const plan = await lookupPlan(book)
    if (plan) {
      return `Skipped ${book}: it needs the ${planTitle(plan)} plan or higher, which your key does not have.`
    }
    return `Skipped ${book}: ${serverText(err)}.`
  }
  if (status === 403 && code === 'book_not_selected') {
    return `Skipped ${book}: it is not in the sportsbook selection on your SharpAPI dashboard. Add it there and run again.`
  }
  if (status === 403) throw new FatalError(keyMessage(err))
  if (status === 410 || status === 503) return `Skipped ${book}: ${serverText(err)}.`
  if (status === 429) {
    throw new FatalError(
      `SharpAPI kept answering HTTP 429 (rate limited) after ${MAX_RATE_LIMIT_RETRIES} retries. Wait a minute and run again.`,
    )
  }
  if (status === 400) {
    throw new FatalError(`SharpAPI rejected the request: ${serverText(err)}. Check the sportsbook, league and market values.`)
  }
  throw new FatalError(`SharpAPI request failed: ${serverText(err)}.`)
}

/**
 * Page through /odds for each chosen sportsbook and push one row per price.
 * Returns how many rows were saved and why any sportsbook was skipped.
 */
export async function collectOdds({ client, input, pushData, log, sleep }) {
  const say = {
    info: (m) => log.info(redact(m, input.apiKey)),
    warning: (m) => log.warning(redact(m, input.apiKey)),
  }

  let plans
  const lookupPlan = async (book) => {
    plans ??= client.sportsbooks.list().then(
      (res) => new Map((res?.data ?? []).map((b) => [b.id, b.requires_tier])),
      () => new Map(),
    )
    return (await plans).get(book) ?? null
  }

  let saved = 0
  const skipped = []
  for (const book of input.sportsbooks) {
    if (saved >= input.maxItems) break
    let cursor
    let bookRows = 0
    for (;;) {
      const limit = Math.min(PAGE_SIZE, input.maxItems - saved)
      let page
      try {
        page = await withBackoff(
          () => client.odds.get(buildQuery({ ...input, sportsbook: book, limit, cursor })),
          { sleep, log: say },
        )
      } catch (err) {
        let reason
        try {
          reason = await explainError(err, book, lookupPlan)
        } catch (fatal) {
          if (fatal instanceof FatalError) throw new FatalError(redact(fatal.message, input.apiKey))
          throw fatal
        }
        say.warning(reason)
        skipped.push(redact(reason, input.apiKey))
        break
      }

      const rows = (page?.data ?? []).map(toRow)
      if (rows.length > 0) await pushData(rows)
      saved += rows.length
      bookRows += rows.length

      const next = page?.pagination
      if (rows.length === 0 || !next?.has_more || !next.next_cursor || saved >= input.maxItems) break
      cursor = next.next_cursor
    }
    say.info(`${book}: saved ${bookRows} prices.`)
  }
  if (saved >= input.maxItems) say.info(`Stopped at maxItems (${input.maxItems}). Raise it to save more prices.`)
  return { saved, skipped }
}

/**
 * The whole actor run. `Actor` is the Apify SDK's Actor class (or a stand in
 * with the same methods), `createClient` builds a SharpAPI client from a key.
 */
export async function runActor({ Actor, log, createClient, sleep }) {
  await Actor.init()
  let apiKey = ''
  try {
    const raw = await Actor.getInput()
    apiKey = typeof raw?.apiKey === 'string' ? raw.apiKey.trim() : ''
    const input = normalizeInput(raw)
    const client = createClient(input.apiKey)

    const filters = [
      `sportsbooks: ${input.sportsbooks.join(', ')}`,
      `league: ${input.league || 'all'}`,
      `market: ${input.marketType || 'all'}`,
      `live only: ${input.liveOnly ? 'yes' : 'no'}`,
    ]
    log.info(`Fetching odds from SharpAPI (${filters.join('; ')}).`)

    const { saved, skipped } = await collectOdds({
      client,
      input,
      pushData: (rows) => Actor.pushData(rows),
      log,
      sleep,
    })

    if (saved === 0 && skipped.length > 0) {
      await Actor.fail(`No prices saved. ${skipped.join(' ')}`)
      return
    }
    const note = saved === 0
      ? 'No prices matched these filters right now.'
      : `Saved ${saved} prices.`
    await Actor.exit(skipped.length > 0 ? `${note} ${skipped.join(' ')}` : note)
  } catch (err) {
    const message = err instanceof FatalError ? err.message : `Unexpected error: ${withoutUrls(err?.message ?? err)}`
    await Actor.fail(redact(message, apiKey))
  }
}
