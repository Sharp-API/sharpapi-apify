# Sportsbook Odds (SharpAPI)

Pull current sportsbook odds into an Apify dataset, one row per price. Choose the sportsbooks, a league, a market and whether you only want live games, and the actor saves every matching price from the [SharpAPI](https://sharpapi.io) odds API.

The actor uses your own SharpAPI key. The free plan covers DraftKings and FanDuel, so you can start without paying anything. On the free plan every price is delayed by 60 seconds; paid plans add no delay.

## What you get

Each row is one price at one sportsbook, for example the DraftKings moneyline on the Cleveland Guardians. A row holds the event, the two teams, the start time, the sportsbook, the market, the selection, the line, the American and decimal odds, the implied probability, whether the game is live, and when SharpAPI last refreshed the price.

The actor follows the API's pages until there are no more results, or until it has saved the number of rows you set in **Maximum prices**.

## Get a free SharpAPI key

1. Go to [sharpapi.io/pricing](https://sharpapi.io/pricing) and sign up for the free plan.
2. Copy your API key from your SharpAPI dashboard.
3. Paste it into the **SharpAPI key** field of this actor.

The free plan covers DraftKings and FanDuel, with every price delayed by 60 seconds. Other sportsbooks, and prices with no added delay, need a paid plan; the pricing page shows which plan includes which sportsbook.

The key field is a secret input: Apify stores it encrypted, and the actor never writes it to the log, the run status or the dataset.

## Input

| Field | What it does |
| --- | --- |
| `apiKey` | Your SharpAPI key. Required. |
| `sportsbook` | The sportsbooks to pull. Defaults to DraftKings and FanDuel. |
| `league` | A league such as `nfl`, `nba`, `mlb` or `nhl`. Separate several with commas. Leave empty for every league. |
| `marketType` | `moneyline`, `spread` or `total`. Leave empty for every market. |
| `liveOnly` | When on, only games in progress are returned. On the free plan these prices are 60 seconds old. |
| `maxItems` | Stop after saving this many rows. Defaults to 1000. Sportsbooks are fetched in the order listed, so with no league or market filter the first one can fill the whole limit. Add a league or market, or raise the limit, to see every sportsbook. |

`moneyline` is the full game winner line. `spread` also covers run lines, puck lines, handicaps and period spreads. `total` covers every total, including period and team totals.

Example input:

```json
{
  "apiKey": "YOUR_SHARPAPI_KEY",
  "sportsbook": ["draftkings", "fanduel"],
  "league": "mlb",
  "marketType": "moneyline",
  "liveOnly": false,
  "maxItems": 1000
}
```

## Output

The fields keep the names the SharpAPI `GET /odds` endpoint uses, so the [API reference](https://docs.sharpapi.io) describes each one.

| Field | Meaning |
| --- | --- |
| `event_id` | SharpAPI's ID for the event |
| `sport`, `league` | Sport and league |
| `home_team`, `away_team` | The two teams |
| `event_start_time` | Scheduled start, in UTC |
| `sportsbook` | The sportsbook offering the price |
| `market_type` | The market, such as `moneyline` or `point_spread` |
| `selection` | The side the price is for |
| `line` | The spread or total number, or `null` for a moneyline |
| `odds_american`, `odds_decimal` | The price in American and decimal form |
| `odds_probability` | The probability implied by the price |
| `is_live` | `true` when the game is in progress |
| `timestamp` | When SharpAPI last refreshed this price. It moves forward on every refresh, so it is not the time the price last changed. |

`odds_probability` comes straight from the price, so it still includes the sportsbook's margin. The actor does not remove the margin.

Example row:

```json
{
  "event_id": "mlb_guardians_whitesox_2026-10-07_b2",
  "sport": "baseball",
  "league": "mlb",
  "home_team": "Chicago White Sox",
  "away_team": "Cleveland Guardians",
  "event_start_time": "2026-10-07T20:00Z",
  "sportsbook": "draftkings",
  "market_type": "moneyline",
  "selection": "CLE Guardians",
  "line": null,
  "odds_american": 101,
  "odds_decimal": 2.01,
  "odds_probability": 0.4975,
  "is_live": false,
  "timestamp": "2026-10-06T19:01:13.792389199Z"
}
```

## When something goes wrong

* **The key is rejected** (HTTP 401 or 403): the run fails with a message that starts with the API's reason and says "Check your SharpAPI key".
* **A sportsbook is not on your plan**: that sportsbook is skipped with a note naming the plan that includes it, and the other sportsbooks still run. If every sportsbook was skipped, the run fails with those notes.
* **Rate limit** (HTTP 429): the actor waits 2, 4, 8, 16 and then 32 seconds between retries. If the limit still has not cleared, the run stops and asks you to try again in a minute.

## Run it on your own machine

```bash
npm install
npm test
apify run --input-file /path/outside/the/repo/input.json
```

Keep the input file with your key outside this folder so it never ends up in git.

## License

MIT
