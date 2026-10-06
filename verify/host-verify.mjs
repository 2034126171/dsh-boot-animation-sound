/**
 * dsh-boot-animation-sound — verification.
 *
 * Runs the SHIPPED host half against a temporary DSH home and a fake Cordis
 * context, drives every HTTP route it registers, and then asserts the one thing
 * this package exists for: that turning the sound on cannot reach
 * `requestFullscreen()`.
 *
 * No dependencies, no DSH, no browser. `node verify/host-verify.mjs`.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

import {
  BUNDLED_MEDIA,
  CLAIM_ROUTE,
  CONFIG_ROUTE,
  DEFAULTS,
  MEDIA_ROUTE,
  REPORT_ROUTE,
  RESET_ROUTE,
  SAVE_ROUTE,
  apply,
  decidePlay,
  normalizeConfig,
  resolveMedia,
  triggerMatches,
} from '../index.js'

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))
const CLIENT = readFileSync(join(PACKAGE_DIR, 'client.js'), 'utf8')
const MANIFEST = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'))

let failures = 0
let checks = 0

/** @param name - what is being asserted. @param ok - the verdict. @param detail - extra context on failure. */
function check(name, ok, detail) {
  checks += 1
  if (ok) {
    console.log(`  PASS  ${name}`)
    return
  }
  failures += 1
  console.log(`  FAIL  ${name}${detail === undefined ? '' : `  (${detail})`}`)
}

/** @param name - what is being asserted. @param actual - observed value. @param expected - required value. */
function equal(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

/** A response double: records the status, the headers and the body bytes. */
class FakeResponse extends Writable {
  constructor() {
    super()
    this.status = 0
    this.headers = {}
    this.chunks = []
  }

  writeHead(status, headers) {
    this.status = status
    this.headers = headers ?? {}
    return this
  }

  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.from(chunk))
    callback()
  }

  /** @returns every byte written to this response. */
  body() {
    return Buffer.concat(this.chunks)
  }
}

/**
 * Mount the Host half with a recording Cordis context.
 * @param config - the profile patch config.
 * @param dshHome - the DSH home this instance believes in.
 * @param options - the test seams `apply` accepts.
 * @returns the recorded routes, index-inject handlers and log lines.
 */
function mount(config, dshHome, options) {
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome
  const routes = []
  const injections = []
  const logs = []
  const ctx = {
    logger: {
      info: (message) => logs.push(['info', message]),
      warn: (message) => logs.push(['warn', message]),
      error: (message) => logs.push(['error', message]),
    },
    on(name, handler) {
      if (name === 'webserver/index-inject') injections.push(handler)
    },
    inject(names, callback) {
      callback({
        get: () => undefined,
        effect: (run) => run(),
        webServer: {
          register: (route) => {
            routes.push(route)
            return () => {}
          },
        },
      })
    },
  }
  apply(ctx, config, options)
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  return { routes, injections, logs }
}

/** @returns the registered route whose path matches. */
function route(routes, path, kind = 'exact') {
  const found = routes.find((candidate) => candidate.path === path && candidate.kind === kind)
  if (found === undefined) throw new Error(`no ${kind} route registered for ${path}`)
  return found
}

/**
 * Invoke one route handler with a fake request and response.
 * @returns the status, headers, raw body and parsed JSON when it was JSON.
 */
async function call(target, { method = 'GET', path = target.path, headers = {}, body } = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  const req = Readable.from(payload === '' ? [] : [Buffer.from(payload)])
  req.method = method
  req.url = path
  req.headers = { ...headers }
  const res = new FakeResponse()
  const finished = once(res, 'finish')
  target.handler(req, res)
  await Promise.race([
    finished,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error('the handler never ended the response')), 5000)),
  ])
  let json = null
  try {
    json = JSON.parse(res.body().toString('utf8'))
  } catch { /* a media response is not JSON, which is expected */ }
  return { status: res.status, headers: res.headers, body: res.body(), json }
}

const home = mkdtempSync(join(tmpdir(), 'dbas-verify-'))

try {
  console.log('\n[1] defaults and coercion')
  const defaults = normalizeConfig({})
  equal('sound defaults to ON (the switch this plugin exists for)', defaults.sound, true)
  equal('volume default', defaults.volume, 0.9)
  equal('skip default', defaults.skip, 'button')
  equal('coverApplication default', defaults.coverApplication, true)
  equal('showFullscreenButton defaults to OFF', defaults.showFullscreenButton, false)
  equal('soundOnFirstInput default', defaults.soundOnFirstInput, true)
  equal('src stays undefined so the bundled clip can apply', defaults.src, undefined)
  equal('junk sound falls back rather than enabling anything odd', normalizeConfig({ sound: 'yes' }).sound, true)
  equal('sound:false is honoured', normalizeConfig({ sound: false }).sound, false)
  equal('volume is clamped', normalizeConfig({ volume: 5 }).volume, 1)
  equal('unknown skip mode falls back', normalizeConfig({ skip: 'nope' }).skip, 'button')
  equal('junk background falls back', normalizeConfig({ background: 'red' }).background, DEFAULTS.background)
  equal('src is preserved as a string', normalizeConfig({ src: 'D:/v/a.mp4' }).src, 'D:/v/a.mp4')
  equal('cleared src stays the empty string', normalizeConfig({ src: '' }).src, '')
  equal('trigger default keeps the pre-trigger behaviour', defaults.trigger, 'pageRefresh')
  equal('frequency default is unlimited', defaults.frequency, 'every')
  equal('a junk trigger falls back', normalizeConfig({ trigger: 'whenever' }).trigger, 'pageRefresh')
  equal('a junk frequency falls back', normalizeConfig({ frequency: 'sometimes' }).frequency, 'every')
  equal('maxPlays is clamped up to at least 1', normalizeConfig({ maxPlays: 0 }).maxPlays, 1)
  equal('maxPlays is clamped down', normalizeConfig({ maxPlays: 99999 }).maxPlays, 1000)
  equal('maxPlays is rounded', normalizeConfig({ maxPlays: 2.6 }).maxPlays, 3)

  console.log('\n[1b] triggers and the frequency ledger')
  equal('appStart accepts the first page load', triggerMatches('appStart', 'appStart'), true)
  equal('appStart ignores a later page load', triggerMatches('appStart', 'pageRefresh'), false)
  equal('pageRefresh accepts the first page load too', triggerMatches('pageRefresh', 'appStart'), true)
  equal('pageRefresh accepts every later page load', triggerMatches('pageRefresh', 'pageRefresh'), true)
  equal('pageRefresh ignores a conversation', triggerMatches('pageRefresh', 'newConversation'), false)
  equal('newConversation accepts a new conversation', triggerMatches('newConversation', 'newConversation'), true)
  equal('newConversation ignores opening an old one', triggerMatches('newConversation', 'sessionOpen'), false)
  equal('anySession accepts opening a conversation', triggerMatches('anySession', 'sessionOpen'), true)
  equal('anySession accepts a new conversation', triggerMatches('anySession', 'newConversation'), true)
  equal('anySession ignores a page load', triggerMatches('anySession', 'pageRefresh'), false)

  const playableMedia = resolveMedia(undefined, home)
  const base = normalizeConfig({})
  const empty = { plays: 0, lastPlayedOn: null }
  equal('a fresh ledger plays', decidePlay(base, playableMedia, 'pageRefresh', empty).play, true)
  equal('a switched-off animation never plays', decidePlay(normalizeConfig({ enabled: false }), playableMedia, 'pageRefresh', empty).reason, 'disabled')
  equal('a trigger mismatch refuses', decidePlay(base, playableMedia, 'newConversation', empty).reason, 'trigger')
  equal('no media refuses', decidePlay(base, resolveMedia('D:/nope.mp4', home), 'pageRefresh', empty).reason, 'no-media')
  equal('decision alone does NOT spend a play', decidePlay(base, playableMedia, 'pageRefresh', empty).play, true)

  const now = new Date(2026, 9, 6, 12, 0, 0)
  const daily = normalizeConfig({ frequency: 'daily' })
  equal('daily plays when the ledger is from yesterday', decidePlay(daily, playableMedia, 'pageRefresh', { plays: 3, lastPlayedOn: '2026-10-05' }, now).play, true)
  equal('daily refuses later the same day', decidePlay(daily, playableMedia, 'pageRefresh', { plays: 3, lastPlayedOn: '2026-10-06' }, now).reason, 'daily')
  const once = normalizeConfig({ frequency: 'once' })
  equal('once plays on an empty ledger', decidePlay(once, playableMedia, 'pageRefresh', empty, now).play, true)
  equal('once refuses after one play', decidePlay(once, playableMedia, 'pageRefresh', { plays: 1, lastPlayedOn: null }, now).reason, 'once')
  const times = normalizeConfig({ frequency: 'times', maxPlays: 2 })
  equal('times plays under budget', decidePlay(times, playableMedia, 'pageRefresh', { plays: 1, lastPlayedOn: null }, now).play, true)
  equal('times refuses at budget', decidePlay(times, playableMedia, 'pageRefresh', { plays: 2, lastPlayedOn: null }, now).reason, 'times')
  equal('times refuses over budget', decidePlay(times, playableMedia, 'pageRefresh', { plays: 9, lastPlayedOn: null }, now).reason, 'times')

  console.log('\n[2] media resolution')
  const bundled = resolveMedia(undefined, home)
  check('never chosen resolves to the bundled clip', bundled.configured === true && bundled.source === 'bundled', JSON.stringify(bundled))
  check('the bundled clip exists in the package', existsSync(BUNDLED_MEDIA), BUNDLED_MEDIA)
  check('the bundled clip is playable video', resolveMedia(undefined, home).kind === 'video')
  const cleared = resolveMedia('', home)
  check('a cleared path means "play nothing" and never falls back', cleared.configured === false && cleared.source === 'cleared', JSON.stringify(cleared))
  const missing = resolveMedia('D:/nope/missing.mp4', home)
  equal('a missing file is reported as such', missing.problem, 'missing-file')
  const junk = join(home, 'notes.txt')
  writeFileSync(junk, 'not a video')
  equal('an unsupported extension is reported', resolveMedia(junk, home).problem, 'unsupported-format')
  const chosen = resolveMedia(BUNDLED_MEDIA, home)
  check('an explicit path resolves as chosen', chosen.source === 'chosen' && chosen.problem === undefined, JSON.stringify(chosen.problem))

  console.log('\n[3] the Host half mounts and answers every route')
  const mounted = mount({}, home)
  equal('one index-inject handler is registered', mounted.injections.length, 1)
  equal('seven routes are registered', mounted.routes.length, 7)

  const configRoute = route(mounted.routes, CONFIG_ROUTE)
  const initial = await call(configRoute)
  equal('config.json answers 200', initial.status, 200)
  equal('config.json reports sound ON', initial.json.settings.sound, true)
  equal('config.json reports the bundled clip kind', initial.json.media.kind, 'video')
  equal('config.json reports the bundled source', initial.json.source, 'bundled')
  check('config.json hands the browser a media URL', typeof initial.json.media.url === 'string' && initial.json.media.url.startsWith(MEDIA_ROUTE), JSON.stringify(initial.json.media))

  const mediaRoute = route(mounted.routes, MEDIA_ROUTE, 'prefix')
  const full = await call(mediaRoute, { path: `${MEDIA_ROUTE}/${encodeURIComponent(bundled.name)}` })
  equal('the media route answers 200', full.status, 200)
  equal('the media route sends video/mp4', full.headers['Content-Type'], 'video/mp4')
  equal('the media route sends the whole file', full.body.length, bundled.bytes)
  check('the media route advertises Range support', full.headers['Accept-Ranges'] === 'bytes')

  const ranged = await call(mediaRoute, {
    path: `${MEDIA_ROUTE}/${encodeURIComponent(bundled.name)}`,
    headers: { range: 'bytes=0-99' },
  })
  equal('a Range request answers 206', ranged.status, 206)
  equal('a Range request returns exactly the asked bytes', ranged.body.length, 100)
  equal('a Range request carries Content-Range', ranged.headers['Content-Range'], `bytes 0-99/${bundled.bytes}`)

  const unsatisfiable = await call(mediaRoute, {
    path: `${MEDIA_ROUTE}/${encodeURIComponent(bundled.name)}`,
    headers: { range: `bytes=${bundled.bytes + 10}-` },
  })
  equal('an unsatisfiable Range answers 416', unsatisfiable.status, 416)

  const wrongName = await call(mediaRoute, { path: `${MEDIA_ROUTE}/somethingelse.mp4` })
  equal('only the configured file is served', wrongName.status, 404)

  console.log('\n[4] the settings page can actually change the sound switch')
  const saveRoute = route(mounted.routes, SAVE_ROUTE)
  const saved = await call(saveRoute, { method: 'POST', body: { sound: false, volume: 0.25 } })
  equal('saving answers ok', saved.json.ok, true)
  equal('the answer already reflects the new sound switch', saved.json.settings.sound, false)
  check('the settings file was written', existsSync(join(home, 'dsh-boot-animation-sound', 'settings.json')))
  const afterSave = await call(configRoute)
  equal('the next read reports the stored sound switch', afterSave.json.settings.sound, false)
  equal('the next read reports the stored volume', afterSave.json.settings.volume, 0.25)

  await call(saveRoute, { method: 'POST', body: { src: '' } })
  const afterClear = await call(configRoute)
  equal('clearing the path stops the animation', afterClear.json.media.kind, 'none')
  equal('a cleared path never falls back to the bundled clip', afterClear.json.source, 'cleared')
  equal('a cleared path reports no effective src', afterClear.json.effectiveSrc, '')

  await call(saveRoute, { method: 'POST', body: { src: 'D:/definitely/not/here.mp4' } })
  const afterBad = await call(configRoute)
  equal('a broken path is reported, not played', afterBad.json.problem, 'missing-file')
  equal('a broken path still refuses to fall back', afterBad.json.media.kind, 'none')

  await call(saveRoute, { method: 'POST', body: { src: BUNDLED_MEDIA, sound: true } })
  const restored = await call(configRoute)
  equal('restoring a good path brings the animation back', restored.json.media.kind, 'video')
  equal('restoring also brings the sound switch back on', restored.json.settings.sound, true)

  const rejected = await call(saveRoute, { method: 'POST', body: { sound: { evil: true }, volume: 'loud' } })
  check('a malformed save is dropped rather than stored', rejected.json.settings.sound === true && rejected.json.settings.volume === 0.25, JSON.stringify(rejected.json.settings))
  const notPost = await call(saveRoute, { method: 'GET' })
  equal('the save route is POST-only', notPost.status, 405)

  console.log('\n[5] the boot report is recorded')
  const reportRoute = route(mounted.routes, REPORT_ROUTE)
  const reported = await call(reportRoute, {
    method: 'POST',
    body: { audio: 'on', muted: false, fullscreen: false, audioDecodedBytes: 4096, why: 'settled' },
  })
  equal('the report route answers ok', reported.json.ok, true)
  const reportFile = join(home, 'dsh-boot-animation-sound', 'last-boot.json')
  check('the report file was written', existsSync(reportFile), reportFile)
  const storedReport = JSON.parse(readFileSync(reportFile, 'utf8'))
  equal('the report keeps the audio outcome', storedReport.audio, 'on')
  equal('the report keeps the full-screen fact', storedReport.fullscreen, false)
  check('the report is timestamped', typeof storedReport.at === 'string')
  const withReport = await call(configRoute)
  check('the settings page can read the last boot back', withReport.json.lastBoot !== null && withReport.json.lastBoot.audio === 'on')

  console.log('\n[5b] a claim spends the ledger, and only a claim does')
  const claimRoute = route(mounted.routes, CLAIM_ROUTE)
  const freshHome = mkdtempSync(join(tmpdir(), 'dbas-claim-'))
  const claimer = mount({ trigger: 'pageRefresh', frequency: 'times', maxPlays: 2 }, freshHome)
  const claim = route(claimer.routes, CLAIM_ROUTE)
  const claimConfig = route(claimer.routes, CONFIG_ROUTE)

  equal('an empty ledger starts at zero', (await call(claimConfig)).json.playState.plays, 0)
  const first = await call(claim, { method: 'POST', body: { occasion: 'appStart' } })
  equal('the first claim plays', first.json.play, true)
  equal('and it spent one play', first.json.playState.plays, 1)
  equal('the ledger on disk agrees', JSON.parse(readFileSync(join(freshHome, 'dsh-boot-animation-sound', 'play-state.json'), 'utf8')).plays, 1)
  const second = await call(claim, { method: 'POST', body: { occasion: 'pageRefresh' } })
  equal('the second claim plays', second.json.play, true)
  equal('and it spent the second', second.json.playState.plays, 2)
  const third = await call(claim, { method: 'POST', body: { occasion: 'pageRefresh' } })
  equal('the third claim is refused', third.json.play, false)
  equal('and it names the setting that refused', third.json.reason, 'times')
  equal('a refused claim spends NOTHING', (await call(claimConfig)).json.playState.plays, 2)

  const wrongOccasion = await call(claim, { method: 'POST', body: { occasion: 'whenever' } })
  equal('an unknown occasion is rejected', wrongOccasion.status, 400)
  const notPostClaim = await call(claim, { method: 'GET' })
  equal('the claim route is POST-only', notPostClaim.status, 405)

  const resetRoute = route(claimer.routes, RESET_ROUTE)
  const afterReset = await call(resetRoute, { method: 'POST' })
  equal('resetting answers with the new state', afterReset.json.playState.plays, 0)
  equal('and the budget is available again', (await call(claim, { method: 'POST', body: { occasion: 'pageRefresh' } })).json.play, true)

  // The daily rule is about the user's calendar day, not a 24 hour window.
  const dailyHome = mkdtempSync(join(tmpdir(), 'dbas-daily-'))
  const dailyMounted = mount({ frequency: 'daily' }, dailyHome)
  const dailyClaim = route(dailyMounted.routes, CLAIM_ROUTE)
  check('the first claim of a day plays', (await call(dailyClaim, { method: 'POST', body: { occasion: 'pageRefresh' } })).json.play === true)
  const sameDay = await call(dailyClaim, { method: 'POST', body: { occasion: 'pageRefresh' } })
  equal('a second claim the same day is refused', sameDay.json.play, false)
  equal('and it says why', sameDay.json.reason, 'daily')
  // Backdate the ledger to yesterday and the budget opens again.
  const dailyState = join(dailyHome, 'dsh-boot-animation-sound', 'play-state.json')
  const backdated = JSON.parse(readFileSync(dailyState, 'utf8'))
  backdated.lastPlayedOn = '2000-01-01'
  writeFileSync(dailyState, JSON.stringify(backdated))
  check('a claim on a later day plays again', (await call(dailyClaim, { method: 'POST', body: { occasion: 'pageRefresh' } })).json.play === true)

  const onceHome = mkdtempSync(join(tmpdir(), 'dbas-once-'))
  const onceMounted = mount({ frequency: 'once' }, onceHome)
  const onceClaim = route(onceMounted.routes, CLAIM_ROUTE)
  check('once plays the first time', (await call(onceClaim, { method: 'POST', body: { occasion: 'pageRefresh' } })).json.play === true)
  const onceAgain = await call(onceClaim, { method: 'POST', body: { occasion: 'pageRefresh' } })
  equal('once never plays again', onceAgain.json.play, false)
  equal('and it says why', onceAgain.json.reason, 'once')

  // A conversation trigger must not fire on a page load at all.
  const conversationHome = mkdtempSync(join(tmpdir(), 'dbas-conv-'))
  const conversationMounted = mount({ trigger: 'newConversation' }, conversationHome)
  const conversationClaim = route(conversationMounted.routes, CLAIM_ROUTE)
  equal('a page load is refused when the trigger is a conversation',
    (await call(conversationClaim, { method: 'POST', body: { occasion: 'pageRefresh' } })).json.reason, 'trigger')
  equal('the conversation occasion is accepted',
    (await call(conversationClaim, { method: 'POST', body: { occasion: 'newConversation' } })).json.play, true)

  for (const leftover of [freshHome, dailyHome, onceHome, conversationHome]) rmSync(leftover, { recursive: true, force: true })
  void claimRoute

  console.log('\n[6] the first-paint cover, and its watchdog')
  const table = []
  mounted.injections[0](table)
  equal('a playable clip injects two rows', table.length, 2)
  const styleRow = table.find((row) => row.kind === 'style')
  const scriptRow = table.find((row) => row.kind === 'script')
  check('the style row hides #root', typeof styleRow?.text === 'string' && styleRow.text.includes('#root{visibility:hidden'))
  check('the style row carries the cover marker', styleRow.text.includes('dsh-boot-animation-sound-cover'))
  check('the style row carries the base marker', styleRow.text.includes('dsh-boot-animation-sound-base'))
  check('the script row arms a watchdog', typeof scriptRow?.text === 'string' && scriptRow.text.includes('__DSH_BOOT_SOUND_COVER_GUARD__'))
  check('the watchdog releases rather than re-arms', scriptRow.text.includes('setTimeout(go,10000)'))

  const noCover = mount({ coverApplication: false }, home)
  const emptyTable = []
  noCover.injections[0](emptyTable)
  equal('coverApplication:false injects nothing', emptyTable.length, 0)

  const offHome = mkdtempSync(join(tmpdir(), 'dbas-off-'))
  const off = mount({ src: '' }, offHome)
  const offTable = []
  off.injections[0](offTable)
  equal('nothing to play injects nothing', offTable.length, 0)
  rmSync(offHome, { recursive: true, force: true })

  // A page load whose animation has spent its budget must NOT be covered: the user
  // would get a black screen and then watch it released for no reason.
  const spentHome = mkdtempSync(join(tmpdir(), 'dbas-spent-'))
  const spent = mount({ frequency: 'once' }, spentHome)
  const firstTable = []
  spent.injections[0](firstTable)
  equal('the first page load of a once-only animation is covered', firstTable.length, 2)
  // Spend the budget the way the browser half would.
  await call(route(spent.routes, CLAIM_ROUTE), { method: 'POST', body: { occasion: 'appStart' } })
  const secondTable = []
  spent.injections[0](secondTable)
  equal('a later page load with a spent budget is NOT covered', secondTable.length, 0)
  rmSync(spentHome, { recursive: true, force: true })

  // The occasion the browser half reports is the Host's own verdict, so a trigger
  // and the cover decision cannot disagree.
  const occasionHome = mkdtempSync(join(tmpdir(), 'dbas-occ-'))
  const occasionMounted = mount({}, occasionHome)
  const occasionTable = []
  occasionMounted.injections[0](occasionTable)
  equal('the first index render is the application start', (await call(route(occasionMounted.routes, CONFIG_ROUTE))).json.pageOccasion, 'appStart')
  occasionMounted.injections[0]([])
  equal('a later index render is a page refresh', (await call(route(occasionMounted.routes, CONFIG_ROUTE))).json.pageOccasion, 'pageRefresh')
  rmSync(occasionHome, { recursive: true, force: true })

  console.log('\n[7] the requirement itself: sound cannot reach full screen')
  // Count CALL SITES, not prose: the header documents the guarantee by naming
  // `requestFullscreen()`, so a naive substring count would measure the comment.
  const codeLines = CLIENT.split('\n')
  const callLines = codeLines
    .map((line, index) => ({ line, index }))
    .filter((entry) => /\.requestFullscreen\s*\(/.test(entry.line))
  equal('client.js makes exactly one full-screen call in code', callLines.length, 1)
  check('no webkitRequestFullscreen fallback exists', !CLIENT.includes('webkitRequestFullscreen'))
  check('no fullscreenchange handling exists', !CLIENT.includes('fullscreenchange'))

  const askLine = codeLines.findIndex((line) => line.includes('const askFullscreen'))
  const askEndLine = codeLines.findIndex((line) => line.includes('const statusText'))
  check('the full-screen button handler was found', askLine !== -1 && askEndLine > askLine)
  check('the one call sits inside the full-screen BUTTON handler',
    callLines.length === 1 && callLines[0].index > askLine && callLines[0].index < askEndLine,
    callLines.length === 1 ? `line ${callLines[0].index}` : `${callLines.length} call sites`)
  check('the full-screen button is off by default in the shipped defaults', DEFAULTS.showFullscreenButton === false)

  const unlockStart = codeLines.findIndex((line) => line.includes('const unlock = React.useCallback'))
  const unlockEnd = codeLines.findIndex((line) => line.includes('// The clip: point the element'))
  check('the unlock path was found', unlockStart !== -1 && unlockEnd > unlockStart)
  const unlockBody = codeLines.slice(unlockStart, unlockEnd).join('\n')
  check('unlocking the sound never mentions full screen', !/fullscreen/i.test(unlockBody))
  check('unlocking the sound makes no full-screen call', !/\.requestFullscreen\s*\(/.test(unlockBody))
  check('unlocking the sound only clears `muted` and replays', unlockBody.includes('video.muted = false') && unlockBody.includes('video.play()'))

  const firstInputStart = codeLines.findIndex((line) => line.includes('// Sound at the first click or key press ANYWHERE'))
  const firstInputEnd = codeLines.findIndex((line) => line.includes('// `skip: auto`'))
  const firstInputBody = codeLines.slice(firstInputStart, firstInputEnd).join('\n')
  check('the first-input unlock was found', firstInputStart !== -1 && firstInputEnd > firstInputStart)
  check('the first-input unlock is a capture listener on window', firstInputBody.includes("window.addEventListener('pointerdown', handler, true)"))
  check('the first-input unlock never enters full screen', !firstInputBody.toLowerCase().includes('fullscreen'))
  check('the first-input unlock never stops or prevents the event', !firstInputBody.includes('stopPropagation') && !firstInputBody.includes('preventDefault'))

  check('the clip is asked to play audibly first (muted is not forced on)', CLIENT.includes('video.muted = !wantSound'))
  check('a muted retry exists so the animation always plays', CLIENT.includes('video.muted = true'))

  console.log('\n[7b] the animation is bound to a page LOAD, not to when the module appears')
  check('the page-load gate exists', CLIENT.includes('function belongsToThisPageLoad'))
  check('the gate reads the Host cover as its precise signal', CLIENT.includes('COVER_MARKERS.some((marker) => text.includes(marker))) return true'))
  check('the gate has a freshness fallback for coverApplication:false', CLIENT.includes('performance.now() < 20000'))
  check('the gate is evaluated once per mount, not per render', CLIENT.includes('if (fresh.current === null) fresh.current = belongsToThisPageLoad()'))
  check('a page-load trigger claims only when the module load IS the page load', CLIENT.includes('if (!ready || !pageTriggers || fresh.current !== true)'))
  check('the occasion claimed is the Host verdict, not a guess', CLIENT.includes('claim(config.pageOccasion)'))

  console.log('\n[7d] the conversation triggers wrap the navigation service, safely')
  check('a watcher exists', CLIENT.includes('function watchConversations'))
  check('it wraps the new-conversation action', CLIENT.includes("wrap('startSession', 'newConversation')"))
  check('it wraps opening an existing conversation', CLIENT.includes("wrap('openSession', 'sessionOpen')"))
  check('the original is called first and its result returned', CLIENT.includes('const result = original.apply(this, args)'))
  check('the notification is isolated from navigation', CLIENT.includes('a failed trigger must never break navigation'))
  check('the wrapper verifies its assignment took effect', CLIENT.includes('if (workspace[method] !== wrapped) return'))
  check('every wrapper can be restored', CLIENT.includes('for (const restore of restores) restore()'))
  check('the watcher is only installed for conversation triggers', CLIENT.includes('if (!CONVERSATION_TRIGGERS.has(trigger)) return'))
  check('it is installed with the plugin lifetime', CLIENT.includes('ctx.effect(() => watchConversations(ctx, report))'))

  console.log('\n[7c] the animation can never keep the interface covered')
  // A slot registry keeps the component MOUNTED for the life of the page, so
  // "finished" has to remove what is painted. A transparent full-screen box still
  // swallows every click, and that defect made the whole application unresponsive
  // while a body-level widget kept animating.
  check('a run gate distinguishes "should run" from "is running"', CLIENT.includes('const running = active && doneNonce !== nonce'))
  check('a finished run is recorded so the NEXT occasion can play again', CLIENT.includes('setDoneNonce(nonceRef.current)'))
  check('nothing is painted once the animation is done', CLIENT.includes('if (!running) return null'))
  check('no effect is still gated on `active` alone', !CLIENT.includes('if (!active) return undefined'))
  check('no effect still lists `active` alone as a dependency', !/\[active,/.test(CLIENT))
  check('pointer events are released with the fade, not only with the unmount', CLIENT.includes("pointerEvents: fading ? 'none' : 'auto'"))
  check('closing stops and detaches the clip at once', CLIENT.includes("video.removeAttribute('src')"))
  check('a hard lifetime ceiling is armed regardless of media events', CLIENT.includes('after(600000,'))
  check('a length that is missing or infinite is still bounded', CLIENT.includes('bound it explicitly'))

  console.log('\n[8] the package declares what DSH looks for')
  equal('dsh.bundle.patch is declared', MANIFEST.dsh?.bundle?.patch, './cordis.patch.yml')
  equal('the client platform is web', MANIFEST.dsh?.client?.platform, 'web')
  equal('the client half loads immediately', MANIFEST.dsh?.client?.immediately, true)
  equal('the client entry is exported', MANIFEST.exports?.['./client'], './client.js')
  check('a DSH engine range is declared', typeof MANIFEST.dsh?.engines?.dsh === 'string')
  equal('the host entry is the package main', MANIFEST.main, './index.js')
  check('the bundled clip is shipped in the package files', Array.isArray(MANIFEST.files) && MANIFEST.files.includes('media'))
  check('the client loader registration id matches the package', CLIENT.includes("id: 'dsh-boot-animation-sound'"))
} finally {
  rmSync(home, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.error(`${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('all good')
