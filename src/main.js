import { Actor, log } from 'apify'
import { createClient } from '@sharp-api/client'

import { runActor } from './actor.js'

await runActor({
  Actor,
  log,
  createClient: (apiKey) => createClient(apiKey),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
})
