// One test per claim the README makes. Each test names the README section
// it backs, so a README edit points at the test that has to change with it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  DEFAULT_SPORTSBOOKS,
  ROW_FIELDS,
  buildQuery,
  normalizeInput,
  runActor,
  toRow,
} from '../src/actor.js'

const KEY = 'sk_test_0123456789abcdef'
const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
const inputSchema = readJson('../.actor/input_schema.json')
const datasetSchema = readJson('../.actor/dataset_schema.json')
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
const readmeJsonBlocks = [...readme.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]))

// A real /odds row, trimmed of nothing: toRow must pick the documented fields out of it.
const API_ROW = {
  id: '153737876699896',
  sportsbook: 'draftkings',
  event_id: 'mlb_braves_dodgers_2026-10-06_b3',
  sport: 'baseball',
  league: 'mlb',
  home_team: 'Atlanta Braves',
  away_team: 'Los Angeles Dodgers',
  market_type: 'moneyline',
  selection: 'LA Dodgers',
  selection_type: 'away',
  odds_american: -110,
  odds_decimal: 1.909,
  odds_probability: 0.5238,
  line: null,
  event_start_time: '2026-10-06T22:00Z',
  is_live: false,
  timestamp: '2026-10-06T18:51:12.757040224Z',
  deep_link: 'https://example.invalid/deeplink',
}

function apiError(status, code, message) {
  return Object.assign(new Error(message), { status, code })
}

function fakeClient(oddsGet, books = []) {
  const calls = []
  return {
    calls,
    odds: {
      get: async (query) => {
        calls.push(query)
        return oddsGet(query, calls.length)
      },
    },
    sportsbooks: { list: async () => ({ data: books }) },
  }
}

function fakeActor(input) {
  const state = { pushed: [], exit: undefined, fail: undefined }
  return {
    state,
    init: async () => {},
    getInput: async () => input,
    pushData: async (rows) => {
      state.pushed.push(...rows)
    },
    exit: async (message) => {
      state.exit = message
    },
    fail: async (message) => {
      state.fail = message
    },
  }
}

function captureLog() {
  const lines = []
  const add = (m) => lines.push(String(m))
  return { lines, info: add, warning: add, error: add, debug: add }
}

async function run(input, oddsGet, { books = [] } = {}) {
  const Actor = fakeActor(input)
  const log = captureLog()
  const sleeps = []
  const client = fakeClient(oddsGet, books)
  await runActor({
    Actor,
    log,
    createClient: () => client,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  })
  return { ...Actor.state, lines: log.lines, sleeps, calls: client.calls }
}

const page = (rows, next) => ({
  data: rows,
  pagination: next ? { has_more: true, next_cursor: next } : { has_more: false },
})

// README "Output": one row per price, under the field names GET /odds uses.
test('each price becomes one row with the documented /odds fields and nothing else', async () => {
  const row = toRow(API_ROW)
  assert.deepEqual(Object.keys(row), ROW_FIELDS)
  for (const field of ROW_FIELDS) assert.equal(row[field], API_ROW[field], field)
  assert.equal('deep_link' in row, false)
  assert.equal(Object.keys(row).some((k) => /vig|fair|^ev_|_ev$/i.test(k)), false)

  const res = await run({ apiKey: KEY, sportsbook: ['draftkings'] }, () => page([API_ROW, API_ROW]))
  assert.equal(res.pushed.length, 2)
})

// README "Output": the example row and the Store table show exactly those fields.
test('the README example row and the dataset view list the same fields as the actor writes', () => {
  const exampleRow = readmeJsonBlocks[1]
  assert.deepEqual(Object.keys(exampleRow), ROW_FIELDS)
  assert.deepEqual(datasetSchema.views.overview.transformation.fields, ROW_FIELDS)
})

// README "Input": the filters map onto the /odds query.
test('league, market and liveOnly become the /odds filters', () => {
  const input = normalizeInput({ apiKey: KEY, league: ' NFL, nba ', marketType: 'Spread', liveOnly: true })
  assert.deepEqual(buildQuery({ ...input, sportsbook: 'fanduel', limit: 500 }), {
    sportsbook: 'fanduel',
    limit: 500,
    league: 'nfl,nba',
    market: 'spread',
    is_live: true,
  })
  const plain = normalizeInput({ apiKey: KEY })
  assert.deepEqual(buildQuery({ ...plain, sportsbook: 'draftkings', limit: 500 }), {
    sportsbook: 'draftkings',
    limit: 500,
  })
})

// README "Input": DraftKings and FanDuel are the default sportsbooks.
test('sportsbooks default to DraftKings and FanDuel, in the schema and in the code', () => {
  assert.deepEqual(DEFAULT_SPORTSBOOKS, ['draftkings', 'fanduel'])
  assert.deepEqual(inputSchema.properties.sportsbook.default, DEFAULT_SPORTSBOOKS)
  assert.deepEqual(normalizeInput({ apiKey: KEY }).sportsbooks, DEFAULT_SPORTSBOOKS)
  for (const book of DEFAULT_SPORTSBOOKS) assert.ok(inputSchema.properties.sportsbook.items.enum.includes(book))
})

// README "Input": the example input is a valid input.
test('the README example input is accepted as is', () => {
  const example = readmeJsonBlocks[0]
  const input = normalizeInput(example)
  assert.deepEqual(Object.keys(example).sort(), Object.keys(inputSchema.properties).sort())
  assert.equal(input.marketType, example.marketType)
  assert.ok(example.sportsbook.every((b) => inputSchema.properties.sportsbook.items.enum.includes(b)))
})

// README "Output": the actor follows the API's pages and stops at maxItems.
test('pages are followed by cursor until the API says there are no more', async () => {
  const res = await run({ apiKey: KEY, sportsbook: ['draftkings'] }, (q, n) =>
    n === 1 ? page([API_ROW], 'c2') : page([API_ROW]))
  assert.equal(res.calls.length, 2)
  assert.equal(res.calls[0].cursor, undefined)
  assert.equal(res.calls[1].cursor, 'c2')
  assert.equal(res.pushed.length, 2)
})

test('the run stops once maxItems rows are saved', async () => {
  const res = await run({ apiKey: KEY, sportsbook: ['draftkings', 'fanduel'], maxItems: 3 }, (q) =>
    page(Array.from({ length: q.limit }, () => API_ROW), 'more'))
  assert.equal(res.pushed.length, 3)
  assert.equal(res.calls.length, 1)
  assert.equal(res.calls[0].limit, 3)
})

// README "Errors": a rejected key fails the run with "Check your SharpAPI key".
for (const [status, code] of [[401, 'invalid_api_key'], [403, 'forbidden']]) {
  test(`HTTP ${status} fails the run and says to check the key`, async () => {
    const res = await run({ apiKey: KEY }, () => {
      throw apiError(status, code, 'Invalid API key')
    })
    assert.match(res.fail, /Check your SharpAPI key/)
    assert.equal(res.exit, undefined)
    assert.equal(res.calls.length, 1)
  })
}

// README "Errors": a sportsbook outside your plan is skipped with the plan it needs.
test('a sportsbook your plan lacks is skipped with the plan that unlocks it, and the others still run', async () => {
  const res = await run(
    { apiKey: KEY, sportsbook: ['pinnacle', 'draftkings'] },
    (q) => {
      if (q.sportsbook === 'pinnacle') {
        throw apiError(403, 'tier_restricted', 'the requested sportsbooks require sharp tier or higher; your current plan is free')
      }
      return page([API_ROW])
    },
    { books: [{ id: 'pinnacle', requires_tier: 'sharp' }, { id: 'draftkings', requires_tier: 'free' }] },
  )
  assert.equal(res.fail, undefined)
  assert.equal(res.pushed.length, 1)
  assert.match(res.exit, /Skipped pinnacle: it needs the Sharp plan or higher/)
  assert.match(res.exit, /https:\/\/sharpapi\.io\/pricing/)
})

test('when every sportsbook is outside the plan, the run fails and names the plan', async () => {
  const res = await run({ apiKey: KEY, sportsbook: ['betmgm'] }, () => {
    throw apiError(403, 'tier_restricted', 'the requested sportsbooks are not available on your current plan')
  }, { books: [{ id: 'betmgm', requires_tier: 'hobby' }] })
  assert.match(res.fail, /No prices saved\. Skipped betmgm: it needs the Hobby plan or higher/)
})

// README "Errors": HTTP 429 waits 2, 4, 8, 16 and 32 seconds, then stops.
test('a 429 backs off and retries, then succeeds', async () => {
  const res = await run({ apiKey: KEY, sportsbook: ['draftkings'] }, (q, n) => {
    if (n <= 2) throw apiError(429, 'rate_limited', 'Rate limit exceeded')
    return page([API_ROW])
  })
  assert.deepEqual(res.sleeps, [2000, 4000])
  assert.equal(res.pushed.length, 1)
  assert.equal(res.fail, undefined)
})

test('a 429 that does not clear stops the run after five waits', async () => {
  const res = await run({ apiKey: KEY, sportsbook: ['draftkings'] }, () => {
    throw apiError(429, 'rate_limited', 'Rate limit exceeded')
  })
  assert.deepEqual(res.sleeps, [2000, 4000, 8000, 16000, 32000])
  assert.match(res.fail, /HTTP 429/)
})

// README "Errors": the key never reaches the log, the run status or the dataset.
test('the key is never written to the log, the run status or the dataset', async () => {
  const leaky = (msg) => apiError(undefined, undefined, `${msg} ${KEY}`)
  const runs = [
    await run({ apiKey: KEY, sportsbook: ['draftkings'] }, (q, n) => {
      if (n === 1) throw apiError(429, 'rate_limited', `slow down ${KEY}`)
      return page([{ ...API_ROW, selection: 'x' }])
    }),
    await run({ apiKey: KEY }, () => {
      throw apiError(401, 'invalid_api_key', `bad key ${KEY}`)
    }),
    await run({ apiKey: KEY, sportsbook: ['pinnacle'] }, () => {
      throw apiError(403, 'tier_restricted', `plan ${KEY}`)
    }),
    await run({ apiKey: KEY }, () => {
      throw leaky('network down')
    }),
  ]
  for (const res of runs) {
    const everything = JSON.stringify([res.lines, res.exit, res.fail, res.pushed])
    assert.equal(everything.includes(KEY), false, everything)
  }
  // Positive control: the messages above did carry the key before redaction.
  assert.match(runs[1].fail, /\[redacted\]/)
})

// README "Get a free key": the key is your own, a secret input, never a default.
test('the key field is a required secret input with no default value', () => {
  const field = inputSchema.properties.apiKey
  assert.equal(field.isSecret, true)
  assert.ok(inputSchema.required.includes('apiKey'))
  assert.equal('default' in field, false)
  assert.equal('prefill' in field, false)
  assert.match(field.description, /https:\/\/sharpapi\.io\/pricing/)
  assert.doesNotMatch(readmeJsonBlocks[0].apiKey, /^sk_/)
})

test('a missing key fails the run with where to get one', async () => {
  const res = await run({}, () => page([]))
  assert.match(res.fail, /https:\/\/sharpapi\.io\/pricing/)
  assert.equal(res.calls.length, 0)
})
