/**
 * dsh-boot-animation-sound — client-half behavioural verification.
 *
 * Loads the SHIPPED `client.js` in this process with a miniature React runtime,
 * a fake DOM, a fake `<video>` and a configurable autoplay policy — the same
 * `NotAllowedError` this app measurably returns for an unmuted `play()` with no
 * user gesture — then drives the real component and asserts what the user asked
 * for:
 *
 *   - the clip is asked to play AUDIBLY first;
 *   - a refusal falls back to a muted start, so the animation always plays;
 *   - the refusal leaves a sound affordance, and the FIRST click/keypress
 *     anywhere turns the sound on;
 *   - that unlock changes `muted` and NOTHING else: no `requestFullscreen()`, no
 *     size change;
 *   - the only way to reach full screen is the optional button, which is off by
 *     default.
 *
 * No dependencies, no DSH, no browser. `node verify/client-smoke.mjs`.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))
const CLIENT = readFileSync(join(PACKAGE_DIR, 'client.js'), 'utf8')

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

/** @param name - what is being asserted. @param actual - observed. @param expected - required. */
function equal(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

// ---------------------------------------------------------------------------
// A miniature React: enough hook semantics to run the shipped component.
// ---------------------------------------------------------------------------

/** @returns a hook runtime plus a render/effect driver. */
function createRenderer() {
  const slots = []
  let cursor = 0
  let currentRefs = new Map()
  let dirty = false
  let unmounted = false

  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))

  const hooks = {
    useState(initial) {
      const index = cursor
      cursor += 1
      if (slots[index] === undefined) slots[index] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial }
      const slot = slots[index]
      return [slot.value, (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (Object.is(value, slot.value)) return
        slot.value = value
        dirty = true
      }]
    },
    useRef(initial) {
      const index = cursor
      cursor += 1
      if (slots[index] === undefined) slots[index] = { kind: 'ref', box: { current: initial } }
      return slots[index].box
    },
    useCallback(fn, deps) {
      const index = cursor
      cursor += 1
      const slot = slots[index]
      if (slot === undefined || !sameDeps(slot.deps, deps)) slots[index] = { kind: 'callback', fn, deps }
      return slots[index].fn
    },
    useEffect(fn, deps) {
      const index = cursor
      cursor += 1
      const slot = slots[index]
      if (slot === undefined || !sameDeps(slot.deps, deps)) {
        // The PREVIOUS cleanup must survive the replacement. Dropping it is
        // exactly how a component leaks a listener or a timer, and a harness that
        // drops it would happily pass a component that never releases the screen.
        slots[index] = { kind: 'effect', fn, deps, cleanup: slot === undefined ? undefined : slot.cleanup, pending: true }
      }
    },
  }

  /** Walk the element tree, attaching `ref` props (React does this at commit). */
  function attachRefs(node, made) {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) attachRefs(child, made)
      return
    }
    if (node.props && node.props.ref && typeof node.props.ref === 'object') {
      const element = made.get(node)
      if (element !== undefined) node.props.ref.current = element
    }
    attachRefs(node.props ? node.props.children : undefined, made)
  }

  return {
    /**
     * Render a component, run its effects, and keep going until the state stops
     * changing — so a promise-driven `useEffect` is reflected in the tree.
     * @returns the settled tree and the fake DOM elements created for it.
     */
    async mount(Component, props, dom) {
      let tree = null
      const made = new Map()
      activeHooks = hooks
      for (let pass = 0; pass < 40; pass += 1) {
        cursor = 0
        tree = Component(props)
        made.clear()
        dom.build(tree, made)
        attachRefs(tree, made)
        // Effects run in declaration order, after the refs are attached.
        for (const slot of slots) {
          if (slot === undefined || slot.kind !== 'effect' || slot.pending !== true) continue
          slot.pending = false
          if (typeof slot.cleanup === 'function') slot.cleanup()
          slot.cleanup = slot.fn()
        }
        dirty = false
        await new Promise((resolve) => setTimeout(resolve, 0))
        if (!dirty) break
      }
      return { tree, made }
    },
    /** Run every effect cleanup, the way unmounting does. */
    unmount() {
      if (unmounted) return
      unmounted = true
      for (const slot of slots) {
        if (slot !== undefined && slot.kind === 'effect' && typeof slot.cleanup === 'function') slot.cleanup()
      }
    },
    /** Force the next `mount` pass to re-run an effect (used after a state change). */
    markDirty() {
      dirty = true
    },
    hooks,
  }
}

// ---------------------------------------------------------------------------
// A fake DOM with a `<video>` that obeys a configurable autoplay policy.
// ---------------------------------------------------------------------------

/** @returns an element factory + text flattener for the miniature renderer. */
function createDom() {
  const elements = []
  // ONE `<video>` for the whole mount. React keeps a DOM node across re-renders;
  // handing out a fresh element per pass would leave the component's ref pointing
  // at an element no effect ever touched.
  const video = createVideo()

  return {
    elements,
    video,
    /** Create the fake DOM node for one rendered element. */
    build(tree, made) {
      const walk = (node) => {
        if (node === null || node === undefined || typeof node !== 'object') return
        if (Array.isArray(node)) {
          node.forEach(walk)
          return
        }
        if (node.type === undefined) return
        const element = node.type === 'video' ? video : { tag: node.type, props: node.props, text: null }
        made.set(node, element)
        elements.push(element)
        walk(node.props ? node.props.children : undefined)
      }
      walk(tree)
    },
    /** @returns every string rendered anywhere in the tree. */
    text(tree) {
      const out = []
      const walk = (node) => {
        if (node === null || node === undefined) return
        if (typeof node === 'string' || typeof node === 'number') {
          out.push(String(node))
          return
        }
        if (Array.isArray(node)) {
          node.forEach(walk)
          return
        }
        if (typeof node !== 'object') return
        walk(node.props ? node.props.children : undefined)
      }
      walk(tree)
      return out
    },
    /** @returns every element in the tree with the given tag. */
    findAll(tree, tag) {
      const out = []
      const walk = (node) => {
        if (node === null || node === undefined) return
        if (Array.isArray(node)) {
          node.forEach(walk)
          return
        }
        if (typeof node !== 'object') return
        if (node.type === tag) out.push(node)
        walk(node.props ? node.props.children : undefined)
      }
      walk(tree)
      return out
    },
  }
}

/** @returns a `<video>` double whose `play()` follows the supplied policy. */
function createVideo() {
  return {
    muted: true,
    volume: 1,
    playbackRate: 1,
    paused: true,
    ended: false,
    readyState: 0,
    duration: 8.06,
    currentTime: 0,
    videoWidth: 1280,
    videoHeight: 720,
    dataset: {},
    error: null,
    webkitAudioDecodedByteCount: 0,
    webkitDecodedFrameCount: 0,
    src: '',
    listeners: {},
    fullscreenRequests: 0,
    addEventListener(type, fn) {
      const list = this.listeners[type] ?? []
      list.push(fn)
      this.listeners[type] = list
    },
    removeEventListener(type, fn) {
      this.listeners[type] = (this.listeners[type] ?? []).filter((entry) => entry !== fn)
    },
    /** Deliver one media event to every listener. */
    emit(type) {
      for (const fn of this.listeners[type] ?? []) fn({ type })
    },
    load() {
      this.readyState = 1
      this.emit('loadedmetadata')
    },
    pause() {
      this.paused = true
    },
    removeAttribute() {
      this.src = ''
    },
    play() {
      return playPolicy(this)
    },
    requestFullscreen() {
      this.fullscreenRequests += 1
      return Promise.resolve()
    },
  }
}

/** The autoplay policy this app measurably applies, made switchable for the test. */
const policy = {
  refuseUnmuted: true,
  /** Set once a real user gesture has happened: the policy then allows sound. */
  gestureGranted: false,
  calls: [],
}

/** @returns a promise resolving when playback starts, rejecting when refused. */
function playPolicy(video) {
  policy.calls.push({ muted: video.muted, volume: video.volume })
  if (policy.refuseUnmuted && !policy.gestureGranted && video.muted === false && video.volume > 0) {
    const error = new Error('play() failed because the user did not interact with the document first')
    error.name = 'NotAllowedError'
    return Promise.reject(error)
  }
  video.paused = false
  video.readyState = 4
  video.webkitAudioDecodedByteCount = 4096
  video.webkitDecodedFrameCount = 120
  queueMicrotask(() => video.emit('playing'))
  return Promise.resolve()
}

// ---------------------------------------------------------------------------
// Install the fake browser, then load the shipped client bundle.
// ---------------------------------------------------------------------------

const windowListeners = new Map()
/** Pending timers, `id -> delay`, so a test can ask which windows were armed. */
const timers = new Map()

const fakeWindow = {
  addEventListener(type, fn) {
    const list = windowListeners.get(type) ?? []
    list.push(fn)
    windowListeners.set(type, list)
  },
  removeEventListener(type, fn) {
    windowListeners.set(type, (windowListeners.get(type) ?? []).filter((entry) => entry !== fn))
  },
  setTimeout(fn, ms) {
    const id = setTimeout(() => {
      timers.delete(id)
      fn()
    }, ms)
    timers.set(id, ms)
    return id
  },
  clearTimeout(id) {
    timers.delete(id)
    clearTimeout(id)
  },
}

const postedReports = []
const configPayload = {
  version: 1,
  settings: {},
  media: { kind: 'none' },
  problem: null,
  source: null,
  lastBoot: null,
  pageOccasion: 'appStart',
  playState: { plays: 0, lastPlayedOn: null },
  bootId: 'test-boot',
}

/**
 * Whether the Host's first-paint cover is present, and how old the document is.
 *
 * Both are inputs to the component's "is this page load mine?" decision, so the
 * test drives them instead of inheriting whatever this Node process happens to
 * report.
 */
const pageState = {
  coverPresent: true,
  documentAgeMs: 120,
}

const fakeStyle = {
  textContent: '/* dsh-boot-animation-sound-cover */ #root{visibility:hidden!important}',
  remove() {},
}

const fakeDocument = {
  body: { id: 'body' },
  head: { getElementsByTagName: () => (pageState.coverPresent ? [fakeStyle] : []) },
  activeElement: null,
  fullscreenElement: null,
  createElement: () => ({}),
}

Object.defineProperty(globalThis, 'performance', {
  value: {
    now: () => pageState.documentAgeMs,
    timeOrigin: 0,
    mark: () => {},
    measure: () => {},
  },
  configurable: true,
  writable: true,
})

Object.defineProperty(globalThis, 'window', { value: fakeWindow, configurable: true, writable: true })
Object.defineProperty(globalThis, 'document', { value: fakeDocument, configurable: true, writable: true })
Object.defineProperty(globalThis, 'navigator', {
  value: {
    language: 'zh-CN',
    userAgent: 'verify-client-smoke',
    userActivation: { isActive: false, hasBeenActive: false },
  },
  configurable: true,
  writable: true,
})
/**
 * What the Host answers to a claim, and what it was asked.
 *
 * `claimAnswer` is the Host's verdict for the next claim; the default allows the
 * play, which is what most scenarios want. `claimCalls` records every occasion the
 * browser half asked about, so a test can assert WHICH occasion was claimed —
 * a trigger that claims the wrong one would otherwise look like it worked.
 */
const host = {
  claimAnswer: { ok: true, play: true, reason: null, playState: { plays: 1, lastPlayedOn: null } },
  claimCalls: [],
}

Object.defineProperty(globalThis, 'fetch', {
  value: async (url, options) => {
    const target = String(url)
    if (target.includes('/report')) {
      postedReports.push(JSON.parse(String(options?.body ?? '{}')))
      return { ok: true, json: async () => ({ ok: true }) }
    }
    if (target.includes('/claim')) {
      host.claimCalls.push(JSON.parse(String(options?.body ?? '{}')))
      return { ok: true, json: async () => JSON.parse(JSON.stringify(host.claimAnswer)) }
    }
    if (target.includes('/config.json')) {
      return { ok: true, json: async () => JSON.parse(JSON.stringify(configPayload)) }
    }
    return { ok: true, json: async () => ({ ok: true }) }
  },
  configurable: true,
  writable: true,
})

let loaderEntry = null
globalThis.window.__ModuleLoader__ = {
  load(entry) {
    loaderEntry = entry
  },
}

/** The hook runtime of the renderer currently rendering, as `require('react')` sees it. */
let activeHooks = null

const React = {
  createElement(type, props, ...children) {
    const flat = children.length === 1 ? children[0] : children
    return { type, props: { ...(props ?? {}), children: flat } }
  },
  useState: (...args) => activeHooks.useState(...args),
  useRef: (...args) => activeHooks.useRef(...args),
  useCallback: (...args) => activeHooks.useCallback(...args),
  useEffect: (...args) => activeHooks.useEffect(...args),
}
const ReactDOM = { createPortal: (node) => node }

// A real file URL, so the suite loads the shipped file on Windows and on the
// Linux CI runner alike. A hand-assembled `file:///` prefix happens to work on
// Windows and produces a double slash on POSIX.
await import(`${pathToFileURL(join(PACKAGE_DIR, 'client.js')).href}?smoke=${Date.now()}`)

console.log('\n[1] the bundle registers the way DSH loads client modules')
check('window.__ModuleLoader__.load was called', loaderEntry !== null)
equal('the module id matches the package', loaderEntry.id, 'dsh-boot-animation-sound')
check('the factory is a function', typeof loaderEntry.factory === 'function')

const module = loaderEntry.factory((name) => {
  if (name === 'react') return React
  if (name === 'react-dom') return ReactDOM
  throw new Error(`unexpected require: ${name}`)
})
check('the module injects the slots service', Array.isArray(module.inject) && module.inject.includes('slots'))
check('the module exposes apply()', typeof module.apply === 'function')

const registrations = []
/** A workspace service double, so the conversation watcher has something to wrap. */
const workspaceCalls = []
const fakeWorkspace = {
  startSession(...args) {
    workspaceCalls.push(['startSession', args])
    return 'started'
  },
  openSession(...args) {
    workspaceCalls.push(['openSession', args])
    return 'opened'
  },
  connectWorkspace(...args) {
    workspaceCalls.push(['connectWorkspace', args])
    return Promise.resolve('s1')
  },
}
const effects = []
const fakeCtx = {
  get(name) {
    return name === 'uiWorkspace' ? fakeWorkspace : undefined
  },
  effect(run) {
    const dispose = run()
    effects.push(dispose)
    return () => {}
  },
  slots: {
    inject(key, run) {
      registrations.push({ key, run })
    },
    register(definition, component) {
      return { definition, component }
    },
  },
}
module.apply(fakeCtx)
equal('two slots are injected', registrations.length, 2)
check('the settings tab is registered', registrations.some((entry) => entry.key === 'settings.plugins.tab'))
check('the frame-wide overlay is registered', registrations.some((entry) => entry.key === 'shell.overlay'))
check('a diagnosis handle is left on globalThis', typeof globalThis.__DSH_BOOT_ANIMATION_SOUND__?.releaseCover === 'function')

const overlay = registrations.find((entry) => entry.key === 'shell.overlay')
const settings = registrations.find((entry) => entry.key === 'settings.plugins.tab')
const Overlay = overlay.run().component
const Settings = settings.run().component
check('both components are functions', typeof Overlay === 'function' && typeof Settings === 'function')

/**
 * @param settingsPatch - settings for this scenario.
 * @param extras - fields the scenario needs to drive beyond the defaults:
 *   `pageOccasion` (what the Host reports for this page load) and `claimAnswer`
 *   (the Host's verdict). They are applied AFTER the defaults, because the
 *   defaults would otherwise overwrite them — which is exactly the trap this
 *   helper's shape exists to avoid.
 * @returns the rendered tree, the renderer and the fake video.
 */
async function boot(settingsPatch, extras = {}) {
  pageState.coverPresent = true
  pageState.documentAgeMs = 120
  Object.assign(configPayload, {
    settings: { enabled: true, sound: true, volume: 0.9, soundOnFirstInput: true, skip: 'button', showFullscreenButton: false, fadeInMs: 0, fadeOutMs: 0, holdAfterEndMs: 0, trigger: 'pageRefresh', frequency: 'every', maxPlays: 3, ...settingsPatch },
    media: { kind: 'video', url: '/dsh-boot-animation-sound/asset/视频测试.mp4', name: '视频测试.mp4', bytes: 1990488 },
    problem: null,
    source: 'bundled',
    pageOccasion: 'appStart',
    playState: { plays: 0, lastPlayedOn: null },
    ...(extras.config ?? {}),
  })
  policy.calls.length = 0
  policy.gestureGranted = false
  postedReports.length = 0
  windowListeners.clear()
  host.claimCalls.length = 0
  host.claimAnswer = extras.claimAnswer ?? { ok: true, play: true, reason: null, playState: { plays: 1, lastPlayedOn: null } }
  const renderer = createRenderer()
  const dom = createDom()
  const { tree } = await renderer.mount(Overlay, {}, dom)
  return { renderer, dom, tree, video: dom.video }
}

console.log('\n[2] sound ON, and the platform refuses audible autoplay (what this app does)')
{
  const { renderer, dom, tree, video } = await boot({ sound: true })
  check('a <video> element was mounted', video !== undefined)
  equal('the FIRST attempt was audible, not muted', policy.calls[0]?.muted, false)
  check('the audible attempt was refused, so a muted retry followed', policy.calls.length === 2 && policy.calls[1].muted === true, JSON.stringify(policy.calls))
  equal('the fallback left the element playing', video.paused, false)
  equal('the fallback left the element muted', video.muted, true)
  const text = dom.text(tree).join(' | ')
  check('the sound affordance is offered after a refusal', text.includes('开声'), text)
  check('no full-screen button is drawn by default', !text.includes('全屏') || text.includes('不用全屏'), text)
  equal('nothing entered full screen', video.fullscreenRequests, 0)
  equal('nothing entered full screen (document state)', fakeDocument.fullscreenElement, null)
  check('the report says it was refused, and says full screen stayed off',
    postedReports.some((report) => report.audio === 'blocked' && report.fullscreen === false && report.muted === true),
    JSON.stringify(postedReports.map((report) => report.audio)))
  renderer.unmount()
}

console.log('\n[3] the first click anywhere turns the sound on, without full screen')
{
  const { renderer, dom, video } = await boot({ sound: true })
  const pointerListeners = windowListeners.get('pointerdown') ?? []
  check('a capture-phase pointerdown listener is armed', pointerListeners.length > 0, JSON.stringify([...windowListeners.keys()]))
  equal('the element is still muted before the click', video.muted, true)

  // The click IS the gesture the audio policy wanted, so the policy now grants it.
  policy.gestureGranted = true
  for (const fn of pointerListeners) fn({ type: 'pointerdown' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  renderer.markDirty()
  const settled = await renderer.mount(Overlay, {}, dom)
  equal('the click unmuted the element', video.muted, false)
  equal('the click did NOT enter full screen', video.fullscreenRequests, 0)
  equal('the click left the element playing', video.paused, false)
  const text = dom.text(settled.tree).join(' | ')
  check('the affordance is replaced by the sound-on chip', !text.includes('点这里开声') && text.includes('声音已开'), text)
  check('the report records the unlock', postedReports.some((report) => report.audio === 'on'), JSON.stringify(postedReports.map((report) => report.audio)))
  renderer.unmount()
}

console.log('\n[4] sound OFF attempts nothing audible and offers nothing')
{
  const { renderer, dom, tree, video } = await boot({ sound: false })
  check('every attempt was muted', policy.calls.length > 0 && policy.calls.every((attempt) => attempt.muted === true), JSON.stringify(policy.calls))
  equal('the element is muted', video.muted, true)
  check('no sound affordance is drawn', !dom.text(tree).join(' ').includes('开声'), dom.text(tree).join(' '))
  check('no first-input listener is armed', (windowListeners.get('pointerdown') ?? []).length === 0)
  check('the report says sound was off by setting', postedReports.some((report) => report.audio === 'off'), JSON.stringify(postedReports.map((report) => report.audio)))
  renderer.unmount()
}

console.log('\n[5] the optional full-screen button is the ONLY route to full screen')
{
  const { renderer, dom, tree, video } = await boot({ sound: true, showFullscreenButton: true })
  const buttons = dom.findAll(tree, 'button')
  check('a skip button and a full-screen button are drawn', buttons.length >= 2, String(buttons.length))
  const fullscreenButton = buttons.find((node) => dom.text(node).join('').includes('全屏') && !dom.text(node).join('').includes('不用全屏'))
  check('the full-screen button exists', fullscreenButton !== undefined, JSON.stringify(buttons.map((node) => dom.text(node).join(''))))
  // Unlock the sound too, to prove the two are independent.
  policy.gestureGranted = true
  for (const fn of windowListeners.get('pointerdown') ?? []) fn({ type: 'pointerdown' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  equal('turning the sound on still did not enter full screen', video.fullscreenRequests, 0)
  fullscreenButton.props.onClick({ stopPropagation() {} })
  equal('only the button enters full screen', video.fullscreenRequests, 1)
  renderer.unmount()
}

console.log('\n[6] a clip with no sound configured never holds the screen')
{
  configPayload.settings = { enabled: true }
  configPayload.media = { kind: 'none' }
  const renderer = createRenderer()
  const dom = createDom()
  const { tree } = await renderer.mount(Overlay, {}, dom)
  equal('nothing is rendered when no clip is configured', tree, null)
  renderer.unmount()
}

console.log('\n[7] the animation RELEASES the screen — the lockout regression')
{
  // The reported failure: the clip played, then the whole application ignored
  // every click while only a body-level widget kept animating. Cause: the overlay
  // is a `position: fixed; inset: 0` box in the root stacking context, and the
  // slot registry keeps the component MOUNTED, so "finished" has to make the
  // component paint NOTHING. Every effect must be torn down with it.
  const pointerCount = () => (windowListeners.get('pointerdown') ?? []).length
  const keyCount = () => (windowListeners.get('keydown') ?? []).length

  /** @returns the skip button rendered in a tree. */
  const skipButtonOf = (tree, dom) => dom.findAll(tree, 'button')
    .find((node) => dom.text(node).join('').includes('跳过'))

  // --- pressing Skip ---
  {
    const { renderer, dom, tree, video } = await boot({ sound: true, skip: 'button' })
    check('the animation is on screen and would swallow clicks', tree !== null)
    const skip = skipButtonOf(tree, dom)
    check('a skip button is rendered', skip !== undefined)
    check('listeners are armed while it runs', pointerCount() > 0 && keyCount() > 0)

    skip.props.onClick({ stopPropagation() {} })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const after = await renderer.mount(Overlay, {}, dom)

    equal('after Skip the overlay paints NOTHING', after.tree, null)
    equal('the video was paused', video.paused, true)
    equal('the video was detached, so the sound stops at once', video.src, '')
    equal('no pointerdown listener is left behind', pointerCount(), 0)
    equal('no keydown listener is left behind', keyCount(), 0)
    equal('nothing entered full screen on the way out', video.fullscreenRequests, 0)
    renderer.unmount()
  }

  // --- the clip ending on its own ---
  {
    const { renderer, dom, video } = await boot({ sound: true, holdAfterEndMs: 0, fadeOutMs: 0 })
    video.ended = true
    video.emit('ended')
    // `finish` schedules the hold and then the fade, so let the timers drain.
    for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
    const after = await renderer.mount(Overlay, {}, dom)

    equal('after the clip ends the overlay paints NOTHING', after.tree, null)
    equal('the video was paused', video.paused, true)
    equal('the video was detached', video.src, '')
    equal('no pointerdown listener is left behind', pointerCount(), 0)
    equal('no keydown listener is left behind', keyCount(), 0)
    renderer.unmount()
  }

  // --- the emergency exit, which must survive every setting ---
  {
    // `skip: never` removes the button and the click-to-leave, so a user who then
    // hits a defect would have no way out at all. Escape is therefore armed in
    // every mode: the one input a stray full-screen surface cannot swallow.
    const { renderer, dom, tree, video } = await boot({ sound: true, skip: 'never' })
    check('skip:never really offers no skip button', skipButtonOf(tree, dom) === undefined)
    const onKey = (windowListeners.get('keydown') ?? [])
    check('a keydown exit is armed even with skip:never', onKey.length > 0, JSON.stringify([...windowListeners.keys()]))
    for (const fn of onKey) fn({ key: 'Escape', preventDefault() {} })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const after = await renderer.mount(Overlay, {}, dom)
    equal('Escape releases the screen in every mode', after.tree, null)
    equal('and it did not enter full screen', video.fullscreenRequests, 0)
    renderer.unmount()
  }

  // --- the hard ceiling, which must never depend on a media event ---
  {
    const { renderer, dom } = await boot({ sound: true })
    check('a lifetime ceiling was armed even with no end event yet',
      [...timers.values()].some((ms) => ms >= 600000),
      JSON.stringify([...timers.values()]))
    renderer.unmount()
  }
}

console.log('\n[8] the animation belongs to a page LOAD, not to a plugin that appears mid-session')
{
  // DSH's client-module graph is live: enabling the plugin loads this file into a
  // page that may have been open for hours. With no first-paint cover and an old
  // document, nothing may be drawn over the working session.
  pageState.coverPresent = false
  pageState.documentAgeMs = 600000
  Object.assign(configPayload, {
    settings: { enabled: true, sound: true, volume: 0.9, trigger: 'pageRefresh', frequency: 'every' },
    media: { kind: 'video', url: '/dsh-boot-animation-sound/asset/视频测试.mp4', name: '视频测试.mp4' },
    problem: null,
    source: 'bundled',
    pageOccasion: 'appStart',
    playState: { plays: 0, lastPlayedOn: null },
  })
  host.claimCalls.length = 0
  host.claimAnswer = { ok: true, play: true, reason: null, playState: { plays: 1, lastPlayedOn: null } }
  policy.calls.length = 0
  const renderer = createRenderer()
  const dom = createDom()
  const { tree } = await renderer.mount(Overlay, {}, dom)
  equal('a module arriving long after page load draws nothing', tree, null)
  equal('and it does not even try to play', policy.calls.length, 0)
  renderer.unmount()

  // Without the cover, a young document is still a boot, so the animation runs.
  pageState.documentAgeMs = 300
  policy.calls.length = 0
  const freshRenderer = createRenderer()
  const freshDom = createDom()
  const { tree: freshTree } = await freshRenderer.mount(Overlay, {}, freshDom)
  check('a young document without the cover still boots', freshTree !== null)
  check('and it does try to play audibly', policy.calls[0]?.muted === false, JSON.stringify(policy.calls))
  freshRenderer.unmount()

  // With the cover present, the animation runs even on a slow boot, which is the
  // case the cover exists for.
  pageState.coverPresent = true
  pageState.documentAgeMs = 600000
  policy.calls.length = 0
  const slowRenderer = createRenderer()
  const slowDom = createDom()
  const { tree: slowTree } = await slowRenderer.mount(Overlay, {}, slowDom)
  check('a covered page load boots even when it took minutes', slowTree !== null)
  slowRenderer.unmount()
}

console.log('\n[9] the trigger decides WHICH occasion is claimed')
{
  // The Host's own verdict, not a guess made in the browser: a trigger and the
  // cover decision are computed from the same counters, so they cannot disagree.
  const { renderer } = await boot({ trigger: 'pageRefresh' })
  equal('a page-load trigger claims with the occasion the Host reported', host.claimCalls[0]?.occasion, 'appStart')
  equal('and the play was requested', host.claimCalls.length, 1)
  renderer.unmount()

  const second = await boot({ trigger: 'appStart' }, { config: { pageOccasion: 'pageRefresh' } })
  equal('a later page load is claimed with the occasion the Host reported', host.claimCalls[0]?.occasion, 'pageRefresh')
  second.renderer.unmount()

  // A conversation trigger must claim NOTHING on a page load: the animation is not
  // for this moment at all.
  const conversation = await boot({ trigger: 'newConversation' })
  equal('a conversation trigger claims nothing on a page load', host.claimCalls.length, 0)
  equal('and it draws nothing yet', conversation.tree, null)
  equal('and it does not play', policy.calls.length, 0)
  conversation.renderer.unmount()

  // A refused claim means no animation, and the cover must come off.
  const denied = await boot({ frequency: 'daily' }, {
    claimAnswer: { ok: true, play: false, reason: 'daily', playState: { plays: 1, lastPlayedOn: '2026-10-06' } },
  })
  equal('a refused claim draws nothing', denied.tree, null)
  equal('and nothing was played', policy.calls.length, 0)
  denied.renderer.unmount()
}

console.log('\n[10] the conversation watcher: wraps navigation, and restores it')
{
  host.claimCalls.length = 0
  host.claimAnswer = { ok: true, play: true, reason: null, playState: { plays: 1, lastPlayedOn: null } }

  // `apply` read the configuration once; the trigger at that time was the default,
  // so install the watcher directly through the exposed handle instead of guessing
  // at module state.
  const handle = globalThis.__DSH_BOOT_ANIMATION_SOUND__
  check('the diagnosis handle exposes the claim helper', typeof handle?.claim === 'function')
  check('the diagnosis handle exposes the play signal', typeof handle?.playStore?.request === 'function')

  // The watcher itself, driven exactly as `apply` installs it.
  const before = { startSession: fakeWorkspace.startSession, openSession: fakeWorkspace.openSession }
  const workspaceCallsBefore = workspaceCalls.length
  const dispose = (() => {
    // Re-create the watcher through the module's own code path by re-applying with
    // the conversation trigger configured.
    configPayload.settings = { ...configPayload.settings, trigger: 'newConversation' }
    const localRegistrations = []
    const localCtx = {
      get: (name) => (name === 'uiWorkspace' ? fakeWorkspace : undefined),
      effect: (run) => {
        const cleanup = run()
        effects.push(cleanup)
        return () => {}
      },
      slots: {
        inject: (key, run) => localRegistrations.push({ key, run }),
        register: (definition, component) => ({ definition, component }),
      },
    }
    module.apply(localCtx)
    return () => {}
  })()
  void dispose

  // `apply` reads the configuration asynchronously, so give it a turn.
  await new Promise((resolve) => setTimeout(resolve, 0))

  check('starting a conversation still returns the original result', fakeWorkspace.startSession('w1') === 'started')
  check('opening a conversation still returns the original result', fakeWorkspace.openSession('s1') === 'opened')
  check('the original methods really ran', workspaceCalls.length >= workspaceCallsBefore + 2, String(workspaceCalls.length))
  check('starting a conversation claimed newConversation', host.claimCalls.some((call) => call.occasion === 'newConversation'))
  check('opening a conversation claimed sessionOpen', host.claimCalls.some((call) => call.occasion === 'sessionOpen'))
  check('the wrapper is not the original any more', fakeWorkspace.startSession !== before.startSession)

  for (const cleanup of effects.reverse()) {
    if (typeof cleanup === 'function') cleanup()
  }
  check('disposal restores the original methods', fakeWorkspace.startSession === before.startSession && fakeWorkspace.openSession === before.openSession)
}

for (const id of timers) clearTimeout(id)
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.error(`${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('all good')
