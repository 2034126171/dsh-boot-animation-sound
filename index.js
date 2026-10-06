/**
 * dsh-boot-animation-sound — Host half.
 *
 * A boot animation for DSH whose sound does NOT require full screen.
 *
 * The behaviour this package exists to fix
 * ----------------------------------------
 * The obvious way to get sound out of a boot video is to unmute on the first
 * click — and the reference plugin does that, but it also calls
 * `requestFullscreen()` in the same handler. The user-visible result is "sound
 * costs me a full screen", which is what this package removes: sound and full
 * screen are separate decisions here, and NOTHING in this package enters full
 * screen unless the user presses a button that says so.
 *
 * The browser rule this works within
 * ----------------------------------
 * Chromium refuses to start audible playback without a user gesture. That was
 * measured on this machine rather than assumed: with no activation, an unmuted
 * `HTMLMediaElement.play()` rejects with `NotAllowedError` (see the client
 * half's report, which records the outcome of the LAST real boot). So there are
 * three cases, and this plugin implements all three:
 *
 *   1. The policy allows it (web carrier with engagement, or a host that
 *      relaxed the policy) — the clip simply starts with sound, no click.
 *   2. The policy refuses — the clip starts muted so the animation always
 *      plays, and the FIRST click or key press anywhere turns the sound on, in
 *      place, without full screen.
 *   3. Sound is switched off in settings — no audible attempt is made at all.
 *
 * This half owns the file system and the HTTP surface:
 *   GET  /dsh-boot-animation-sound/config.json  effective settings + media descriptor
 *   POST /dsh-boot-animation-sound/config       store settings from the settings page
 *   POST /dsh-boot-animation-sound/pick         open a native file dialog
 *   POST /dsh-boot-animation-sound/report       record what the last boot actually did
 *   GET  /dsh-boot-animation-sound/asset/<name> the media bytes, Range-capable
 *
 * It also injects the first-paint cover: the served HTML hides the application
 * and forces a dark base colour while the animation owns the screen, so a slow
 * boot does not show the interface for a frame and then take it away again. The
 * browser half removes that cover, and a timer in the injected script removes it
 * if the browser half never runs.
 *
 * @module dsh-boot-animation-sound
 */

import { spawn } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { extname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Absolute path of the installed package. */
const PACKAGE_DIR = resolve(fileURLToPath(new URL('./', import.meta.url)))

/** Every route this plugin owns, all under one prefix. */
const ROUTE_BASE = '/dsh-boot-animation-sound'
const CONFIG_ROUTE = `${ROUTE_BASE}/config.json`
const SAVE_ROUTE = `${ROUTE_BASE}/config`
const PICK_ROUTE = `${ROUTE_BASE}/pick`
const REPORT_ROUTE = `${ROUTE_BASE}/report`
const MEDIA_ROUTE = `${ROUTE_BASE}/asset`

/** Where this plugin keeps its own state under the DSH home. */
const STATE_DIRNAME = 'dsh-boot-animation-sound'

/** The clip played when the user has never chosen one. */
const BUNDLED_MEDIA = join(PACKAGE_DIR, 'media', 'default2.mp4')

/**
 * Container extensions accepted for the video, mapped to the MIME type a
 * `<video>` element needs. Still images and animated images are deliberately
 * absent: they cannot carry the sound this plugin is about.
 */
const FORMATS = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  ogv: 'video/ogg',
  ogm: 'video/ogg',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  ts: 'video/mp2t',
}

/** MIME types a `<video>` element will seek in, so `Range` is advertised for them. */
const SEEKABLE = new Set(['video/mp4', 'video/webm', 'video/x-matroska', 'video/ogg', 'video/quicktime', 'video/mp2t'])

const MAX_MEDIA_BYTES = 4096 * 1024 * 1024
const MAX_SRC_LENGTH = 4096
const PICK_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Documented defaults.
 *
 * A plain object rather than a schema, so the package resolves with no
 * dependencies at all. Every field is coerced by {@link normalizeConfig}: a bad
 * value degrades that one setting instead of refusing to boot.
 */
export const DEFAULTS = {
  /**
   * Whether the animation runs at all.
   *
   * Kept separate from `src` so "stop showing it" does not destroy the chosen
   * path — clearing the path is the destructive gesture, and this is the
   * reversible one.
   */
  enabled: true,
  src: undefined,
  /**
   * The switch this plugin exists for.
   *
   * `true` means "try to play this clip with its sound". It is NOT a promise
   * that the platform will allow it: case 2 in the module doc applies whenever
   * the policy refuses, and then one click turns the sound on without full
   * screen.
   */
  sound: true,
  volume: 0.9,
  /**
   * Turn the sound on at the first click or key press anywhere in the window.
   *
   * This is what makes "sound without full screen" convenient rather than
   * merely possible: the user does not have to find the sound chip, they only
   * have to touch the page. `false` leaves the chip as the only way in.
   */
  soundOnFirstInput: true,
  /** How the clip fills the window: `cover` crops, `contain` letterboxes, `fill` stretches. */
  fit: 'cover',
  background: '#000000',
  fadeInMs: 320,
  fadeOutMs: 360,
  playbackRate: 1,
  /** Longest playback in ms; `0` plays the clip to its end. */
  duration: 0,
  /** Extra replays after the first pass; `0` plays once. */
  maxReplays: 0,
  /** Pause between the last frame and the start of the fade out. */
  holdAfterEndMs: 120,
  /** How the animation can be dismissed: `button`, `click`, `auto` or `never`. */
  skip: 'button',
  /** Delay before `skip: auto` dismisses. */
  skipAfterMs: 1500,
  /**
   * Offer a full-screen BUTTON.
   *
   * Off by default, and structurally incapable of affecting sound: it is a
   * separate control that only ever calls `requestFullscreen()`. Turning the
   * sound on never touches it, which is the whole point of this package.
   */
  showFullscreenButton: false,
  /**
   * Hide the application behind the animation from the first paint.
   *
   * On, the screen is black until the animation paints, so the boot never shows
   * the interface and then covers it. The injected watchdog releases the cover
   * if the browser half fails to load.
   */
  coverApplication: true,
}

const SKIP_MODES = new Set(['button', 'click', 'auto', 'never'])
const FIT_MODES = new Set(['contain', 'cover', 'fill'])

/** @returns `value` when it is a finite number inside `[min, max]`, else `fallback`. */
function clampNumber(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(value, min), max)
}

/** @returns `value` when it is one of `allowed`, else `fallback`. */
function oneOf(value, allowed, fallback) {
  return typeof value === 'string' && allowed.has(value) ? value : fallback
}

/** @returns `value` when it is a boolean, else `fallback`. */
function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Coerce a raw configuration into the effective settings.
 * @param raw - merged configuration object.
 * @returns the effective configuration with every field present and valid.
 */
export function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const background = typeof input.background === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(input.background)
    ? input.background
    : DEFAULTS.background
  return {
    enabled: bool(input.enabled, DEFAULTS.enabled),
    // `undefined` is preserved and means "never chosen", which is what lets the
    // bundled clip apply. An empty string means "cleared": never play.
    src: typeof input.src === 'string' ? input.src.slice(0, MAX_SRC_LENGTH) : undefined,
    sound: bool(input.sound, DEFAULTS.sound),
    volume: clampNumber(input.volume, DEFAULTS.volume, 0, 1),
    soundOnFirstInput: bool(input.soundOnFirstInput, DEFAULTS.soundOnFirstInput),
    fit: oneOf(input.fit, FIT_MODES, DEFAULTS.fit),
    background,
    fadeInMs: clampNumber(input.fadeInMs, DEFAULTS.fadeInMs, 0, 10000),
    fadeOutMs: clampNumber(input.fadeOutMs, DEFAULTS.fadeOutMs, 0, 10000),
    playbackRate: clampNumber(input.playbackRate, DEFAULTS.playbackRate, 0.1, 4),
    duration: clampNumber(input.duration, DEFAULTS.duration, 0, 600000),
    maxReplays: Math.round(clampNumber(input.maxReplays, DEFAULTS.maxReplays, 0, 100)),
    holdAfterEndMs: clampNumber(input.holdAfterEndMs, DEFAULTS.holdAfterEndMs, 0, 60000),
    skip: oneOf(input.skip, SKIP_MODES, DEFAULTS.skip),
    skipAfterMs: clampNumber(input.skipAfterMs, DEFAULTS.skipAfterMs, 0, 60000),
    showFullscreenButton: bool(input.showFullscreenButton, DEFAULTS.showFullscreenButton),
    coverApplication: bool(input.coverApplication, DEFAULTS.coverApplication),
  }
}

/** @returns the lower-case extension of `file`, without the dot. */
function extensionOf(file) {
  return extname(file).replace(/^\./, '').toLowerCase()
}

/**
 * Resolve a configured media reference to an absolute file path.
 * @param reference - the configured `src`.
 * @param dshHome - absolute DSH home directory.
 * @returns the absolute candidate path.
 */
function toAbsolutePath(reference, dshHome) {
  if (reference.startsWith('~/') || reference.startsWith('~\\')) return join(homedir(), reference.slice(2))
  if (isAbsolute(reference)) return resolve(reference)
  return resolve(dshHome, reference)
}

/**
 * Describe the file to play, or why it cannot be played.
 *
 * Three input states, and the difference between the first two is deliberate:
 *   - `undefined` — nothing was ever chosen, so the bundled clip applies.
 *   - `''` — the user cleared it. Nothing plays, and the bundled clip must not
 *     be substituted: that is what makes "clear it and it stops" true.
 *   - a path — resolved and validated.
 *
 * @param src - the effective `src` value, or `undefined` when never chosen.
 * @param dshHome - absolute DSH home directory.
 * @returns a media descriptor, or `{ configured: false }`.
 */
export function resolveMedia(src, dshHome) {
  const reference = typeof src === 'string' ? src.trim() : ''
  const cleared = src === ''
  const path = reference === ''
    ? (cleared ? '' : BUNDLED_MEDIA)
    : toAbsolutePath(reference, dshHome)
  const source = reference === '' ? (cleared ? 'cleared' : 'bundled') : 'chosen'

  if (path === '') return { configured: false, source }

  const extension = extensionOf(path)
  const mime = FORMATS[extension]

  // Existence is checked before the extension: it is the more fundamental fact,
  // and the other order reports a typo as "unsupported format", which sends the
  // user looking in the wrong place.
  if (!existsSync(path)) return { configured: true, source, problem: 'missing-file', extension, path }

  let stats
  try {
    stats = statSync(path)
  } catch {
    return { configured: true, source, problem: 'unreadable-file', extension, path }
  }
  if (!stats.isFile()) return { configured: true, source, problem: 'not-a-file', extension, path }
  if (mime === undefined) return { configured: true, source, problem: 'unsupported-format', extension, path }
  if (stats.size > MAX_MEDIA_BYTES) return { configured: true, source, problem: 'file-too-large', extension, path }

  return {
    configured: true,
    source,
    path,
    name: path.slice(path.lastIndexOf(sep) + 1),
    extension,
    mime,
    kind: 'video',
    bytes: stats.size,
    mtimeMs: Math.round(stats.mtimeMs),
  }
}

/** @returns true when this media descriptor is something the browser should play. */
function playable(media) {
  return media.configured === true && media.problem === undefined
}

/** Shared 404 body. */
function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end('not found')
}

/** @returns the state directory, created on demand. */
function stateDir(dshHome) {
  return join(dshHome, STATE_DIRNAME)
}

/** @returns the state file holding the settings page's overrides. */
function stateFile(dshHome) {
  return join(stateDir(dshHome), 'settings.json')
}

/**
 * Read the settings page's overrides.
 * @param dshHome - absolute DSH home directory.
 * @returns the stored object, or `{}` when absent or unreadable.
 */
function readState(dshHome) {
  try {
    const parsed = JSON.parse(readFileSync(stateFile(dshHome), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Write the settings page's overrides.
 * @param dshHome - absolute DSH home directory.
 * @param value - the object to store.
 */
function writeState(dshHome, value) {
  mkdirSync(stateDir(dshHome), { recursive: true })
  const file = stateFile(dshHome)
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  // Rename over the target, so a crash mid-write cannot leave a half file that
  // fails to parse on the next boot.
  renameSync(temporary, file)
}

/**
 * Record what the last boot actually did, for the settings page and for
 * diagnosis.
 * @param dshHome - absolute DSH home directory.
 * @param report - the browser half's report.
 */
function writeBootReport(dshHome, report) {
  mkdirSync(stateDir(dshHome), { recursive: true })
  writeFileSync(join(stateDir(dshHome), 'last-boot.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

/**
 * Read the last boot report.
 * @param dshHome - absolute DSH home directory.
 * @returns the stored report, or `null`.
 */
function readBootReport(dshHome) {
  try {
    return JSON.parse(readFileSync(join(stateDir(dshHome), 'last-boot.json'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Parse one `Range` header against a known length.
 * @param header - the raw header value.
 * @param size - the resource length in bytes.
 * @returns the inclusive byte range, or `undefined` when malformed or unsatisfiable.
 */
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim())
  if (match === null) return undefined
  const [, rawStart, rawEnd] = match
  let start
  let end
  if (rawStart === '') {
    if (rawEnd === '') return undefined
    start = Math.max(0, size - Number(rawEnd))
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return undefined
  return { start, end }
}

/**
 * Stream one resolved video, honouring `Range` so the element can seek.
 * @param req - the HTTP request.
 * @param res - the HTTP response.
 * @param media - a descriptor from {@link resolveMedia}.
 */
function serveMedia(req, res, media) {
  const headers = {
    'Content-Type': media.mime,
    'Cache-Control': 'no-cache',
    'Accept-Ranges': SEEKABLE.has(media.mime) ? 'bytes' : 'none',
    'Content-Disposition': 'inline',
    'X-Content-Type-Options': 'nosniff',
    ETag: `"${media.mtimeMs.toString(36)}-${media.bytes.toString(36)}"`,
  }

  if (req.headers['if-none-match'] === headers.ETag) {
    res.writeHead(304, headers)
    res.end()
    return
  }

  const seekable = SEEKABLE.has(media.mime)
  const range = seekable ? parseRange(req.headers.range, media.bytes) : undefined
  if (seekable && req.headers.range !== undefined && range === undefined) {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${media.bytes}` })
    res.end()
    return
  }

  const start = range === undefined ? 0 : range.start
  const end = range === undefined ? media.bytes - 1 : range.end
  res.writeHead(range === undefined ? 200 : 206, {
    ...headers,
    'Content-Length': String(end - start + 1),
    ...range === undefined ? {} : { 'Content-Range': `bytes ${start}-${end}/${media.bytes}` },
  })

  if (req.method === 'HEAD') {
    res.end()
    return
  }

  const stream = createReadStream(media.path, { start, end })
  let failed = false
  stream.on('error', () => {
    failed = true
    try {
      res.destroy()
    } catch { /* the socket may already be gone */ }
  })
  res.on('close', () => {
    if (!failed) stream.destroy()
  })
  stream.pipe(res)
}

/**
 * Read a JSON request body with a hard size ceiling.
 * @param req - the HTTP request.
 * @param limit - maximum accepted bytes.
 * @returns the parsed body, or `undefined` when absent, oversized or not JSON.
 */
function readJsonBody(req, limit) {
  return new Promise((resolveBody) => {
    const chunks = []
    let size = 0
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolveBody(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        finish(undefined)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        finish(undefined)
      }
    })
    req.on('error', () => finish(undefined))
  })
}

/**
 * Open a native file dialog and resolve the chosen path.
 *
 * Electron's own dialog first — the DSH Desktop host runs inside Electron, so
 * this needs no child process. Then Windows PowerShell's WinForms dialog. When
 * neither exists the settings page keeps its text field, which always works.
 *
 * @param ctx - the plugin context, used for logging.
 * @param initial - an existing path to start the dialog at.
 * @returns the chosen absolute path, `''` on cancel, or `undefined` when no dialog exists.
 */
async function pickMediaFile(ctx, initial) {
  const viaElectron = await pickViaElectron(initial)
  if (viaElectron !== undefined) return viaElectron
  if (process.platform === 'win32') return pickViaPowerShell(ctx, initial)
  return undefined
}

/**
 * Try Electron's native dialog.
 * @param initial - starting path.
 * @returns the path, `''` for a cancel, or `undefined` when Electron is absent.
 */
async function pickViaElectron(initial) {
  if (process.versions.electron === undefined && process.type === undefined) return undefined
  let dialog
  try {
    const { createRequire } = await import('node:module')
    const require = createRequire(import.meta.url)
    const electron = require('electron')
    dialog = electron.dialog ?? electron.main?.dialog
  } catch {
    return undefined
  }
  if (dialog === undefined || typeof dialog.showOpenDialog !== 'function') return undefined
  try {
    const result = await dialog.showOpenDialog({
      title: '选择开机动画视频',
      properties: ['openFile'],
      defaultPath: initial === '' ? undefined : initial,
      filters: [
        { name: '视频', extensions: Object.keys(FORMATS) },
        { name: '全部文件', extensions: ['*'] },
      ],
    })
    if (result.canceled === true || !Array.isArray(result.filePaths) || result.filePaths.length === 0) return ''
    return result.filePaths[0]
  } catch {
    return undefined
  }
}

/**
 * Run a WinForms common file dialog in a child PowerShell.
 *
 * Windows PowerShell 5.1 defaults to STA, which the common dialog requires, and
 * the chosen path travels through a UTF-8 FILE rather than stdout: a console
 * encodes with the system ANSI code page, so a path with non-ASCII characters
 * arrives as mojibake when read back as UTF-8.
 *
 * @param ctx - the plugin context.
 * @param initial - starting path.
 * @returns the chosen path, `''` on cancel, or `undefined` when unavailable.
 */
function pickViaPowerShell(ctx, initial) {
  const carrier = join(tmpdir(), `dsh-boot-animation-sound-pick-${process.pid}-${Date.now()}.txt`)
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    '$d = New-Object System.Windows.Forms.OpenFileDialog',
    '$d.Title = "选择开机动画视频"',
    '$d.Filter = "视频|*.mp4;*.m4v;*.webm;*.mkv;*.mov;*.ogv;*.mpg;*.mpeg;*.ts|全部文件|*.*"',
    '$d.CheckFileExists = $true',
    `$initial = ${JSON.stringify(initial === '' ? '' : initial)}`,
    'if ($initial -ne "") { $d.InitialDirectory = [System.IO.Path]::GetDirectoryName($initial); $d.FileName = $initial }',
    'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
    `  [System.IO.File]::WriteAllText(${JSON.stringify(carrier)}, $d.FileName, (New-Object System.Text.UTF8Encoding($false)))`,
    '}',
  ].join('\n')

  return new Promise((resolvePick) => {
    let child
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true })
    } catch (error) {
      ctx.logger.warn(`dsh-boot-animation-sound: powershell.exe could not be started (${error.code ?? error.message}); the settings page keeps its text field.`)
      resolvePick(undefined)
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch { /* it may already be gone */ }
      resolvePick('')
    }, PICK_TIMEOUT_MS)
    child.on('error', (error) => {
      clearTimeout(timer)
      ctx.logger.warn(`dsh-boot-animation-sound: the file dialog could not run (${error.code ?? error.message}); the settings page keeps its text field.`)
      resolvePick(undefined)
    })
    child.on('close', () => {
      clearTimeout(timer)
      try {
        if (!existsSync(carrier)) {
          resolvePick('')
          return
        }
        const chosen = readFileSync(carrier, 'utf8').replace(/^\uFEFF/, '').trim()
        unlinkSync(carrier)
        resolvePick(chosen)
      } catch {
        resolvePick(undefined)
      }
    })
  })
}

/**
 * Mount the Host half.
 *
 * @param ctx - the plugin context.
 * @param rawConfig - the `config` block from the profile patch, if any.
 * @param options - test seams; production callers omit them.
 * @param options.picker - replaces {@link pickMediaFile}.
 */
export function apply(ctx, rawConfig, options = {}) {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const patchConfig = normalizeConfig(rawConfig)
  const pick = options.picker ?? ((initial) => pickMediaFile(ctx, initial))

  /**
   * Effective settings: the profile patch, with the settings page's file on top.
   *
   * Re-read per request rather than cached at mount, so a change made in the
   * settings page applies to the next page load without restarting DSH.
   * @returns the merged, normalized configuration.
   */
  const settings = () => {
    const merged = { ...patchConfig }
    for (const [key, value] of Object.entries(readState(dshHome))) {
      if (key in DEFAULTS) merged[key] = value
    }
    return normalizeConfig(merged)
  }

  /** @returns the effective settings plus the resolved media. */
  const resolved = () => {
    const effective = settings()
    return { effective, media: resolveMedia(effective.src, dshHome) }
  }

  /**
   * The wire shape shared by every route that answers with the current state,
   * so the settings page parses one object.
   * @param effective - effective settings.
   * @param media - resolved media.
   * @param extra - fields specific to one route.
   * @returns the response body.
   */
  const describe = (effective, media, extra = {}) => ({
    version: 1,
    settings: effective,
    media: playable(media)
      ? {
          url: `${MEDIA_ROUTE}/${encodeURIComponent(media.name)}`,
          name: media.name,
          kind: media.kind,
          mime: media.mime,
          extension: media.extension,
          bytes: media.bytes,
        }
      : { kind: 'none', name: media.name, extension: media.extension },
    problem: media.problem ?? null,
    /** Which rule chose the media: `bundled`, `chosen` or `cleared`. */
    source: media.source ?? null,
    /** What the path field should show. */
    effectiveSrc: media.configured === true ? (media.source === 'bundled' ? BUNDLED_MEDIA : effective.src) : '',
    /** True once the user has chosen something, or cleared it on purpose. */
    chosen: media.source === 'chosen' || media.source === 'cleared',
    lastBoot: readBootReport(dshHome),
    ...extra,
  })

  // Hide the application behind the animation, and suppress the shell's own
  // "Loading plugins…" layer while the animation is going to cover the screen
  // anyway. Registered synchronously and first: the injected row table is
  // collected at host startup, so a handler attached after the first await never
  // contributes.
  ctx.on('webserver/index-inject', (table) => {
    try {
      if (!Array.isArray(table)) return
      const { effective, media } = resolved()
      if (!effective.enabled || !playable(media) || !effective.coverApplication) return
      const alreadyPresent = table.some((row) => row && row.kind === 'style' && typeof row.text === 'string' && row.text.includes('dsh-boot-animation-sound-cover'))
      if (alreadyPresent) return

      // Three rules. The release is the whole design: the cover and the dark
      // base colour are REMOVED by the browser half, never re-evaluated by a
      // selector. A selector-based release re-arms when the animation unmounts,
      // which hides the interface for good.
      table.push({
        kind: 'style',
        text: '/* dsh-boot-animation-sound-boot */ [data-dsh-boot]:has([data-dsh-boot-spinner]){display:none!important}'
          + '/* dsh-boot-animation-sound-cover */ #root{visibility:hidden!important}'
          + '/* dsh-boot-animation-sound-base */ html,body{background-color:#000!important}',
      })

      // A bounded way out if the browser half never runs. A NEW script element
      // per page load is what makes this safe: a re-served style with its own
      // timer would accumulate delays across reloads.
      table.push({
        kind: 'script',
        placement: 'head',
        text: '/* dsh-boot-animation-sound-guard */'
          + 'try{'
          + 'var m=["dsh-boot-animation-sound-cover","dsh-boot-animation-sound-base"];'
          + 'var go=function(){try{'
          + 'var ss=document.head?document.head.getElementsByTagName("style"):[],doomed=[];'
          + 'for(var i=0;i<ss.length;i++){var x=ss[i].textContent||"";'
          + 'for(var j=0;j<m.length;j++){if(x.indexOf(m[j])!==-1){doomed.push(ss[i]);break}}}'
          + 'for(var k=0;k<doomed.length;k++){doomed[k].remove()}}catch(e){}};'
          + 'var t=setTimeout(go,10000);'
          + 'globalThis.__DSH_BOOT_SOUND_COVER_GUARD__={release:go,clear:function(){clearTimeout(t)}}'
          + '}catch(e){}',
      })
    } catch { /* a broken settings read must not break index rendering */ }
  })

  ctx.inject(['webServer'], (scoped) => {
    /**
     * Reject anything that is not this machine's own authenticated client.
     * @returns true when the response has already been written.
     */
    const guard = (req, res) => {
      let connection
      try {
        connection = scoped.get('connection')
      } catch {
        connection = undefined
      }
      if (connection === undefined || typeof connection.requestRejection !== 'function') return false
      const rejection = connection.requestRejection(req)
      if (rejection === undefined) return false
      res.writeHead(rejection)
      res.end()
      return true
    }

    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: CONFIG_ROUTE,
      handler: (req, res) => {
        if (guard(req, res)) return
        const { effective, media } = resolved()
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(describe(effective, media)))
      },
    }))

    // The settings page is the only writer of the stored settings.
    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: SAVE_ROUTE,
      handler: async (req, res) => {
        if (guard(req, res)) return
        if (req.method !== 'POST') {
          res.writeHead(405, { Allow: 'POST' })
          res.end()
          return
        }
        const body = await readJsonBody(req, 16 * 1024)
        if (body === undefined || body === null || typeof body !== 'object') {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: 'invalid-body' }))
          return
        }
        const next = { ...readState(dshHome) }
        // Only the fields the settings page owns are accepted, and each is
        // validated by the same normalizer the read path uses: an unknown or
        // malformed value is dropped rather than stored.
        if (typeof body.src === 'string') next.src = body.src.trim().slice(0, MAX_SRC_LENGTH)
        if (typeof body.sound === 'boolean') next.sound = body.sound
        if (typeof body.volume === 'number') next.volume = normalizeConfig({ volume: body.volume }).volume
        if (typeof body.soundOnFirstInput === 'boolean') next.soundOnFirstInput = body.soundOnFirstInput
        if (typeof body.enabled === 'boolean') next.enabled = body.enabled
        if (typeof body.skip === 'string') next.skip = normalizeConfig({ skip: body.skip }).skip
        if (typeof body.showFullscreenButton === 'boolean') next.showFullscreenButton = body.showFullscreenButton
        try {
          writeState(dshHome, next)
        } catch (error) {
          ctx.logger.warn(`dsh-boot-animation-sound: could not write the settings file (${error.code ?? error.message})`)
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: 'write-failed' }))
          return
        }
        const { effective, media } = resolved()
        ctx.logger.info(`dsh-boot-animation-sound: settings saved (sound=${String(effective.sound)}, src=${String(effective.src ?? '')})`)
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(describe(effective, media, { ok: true })))
      },
    }))

    // The browser cannot read a local path, so the pick happens in the Host.
    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: PICK_ROUTE,
      handler: async (req, res) => {
        if (guard(req, res)) return
        if (req.method !== 'POST') {
          res.writeHead(405, { Allow: 'POST' })
          res.end()
          return
        }
        const chosen = await pick(settings().src)
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(chosen === undefined ? { ok: false, error: 'picker-unavailable' } : { ok: true, path: chosen }))
      },
    }))

    // What the LAST real boot did. This is the record that answers "did it have
    // sound, and did anything enter full screen" without needing a console.
    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: REPORT_ROUTE,
      handler: async (req, res) => {
        if (guard(req, res)) return
        if (req.method !== 'POST') {
          res.writeHead(405, { Allow: 'POST' })
          res.end()
          return
        }
        const body = await readJsonBody(req, 16 * 1024)
        if (body === undefined || body === null || typeof body !== 'object') {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: 'invalid-body' }))
          return
        }
        const report = { at: new Date().toISOString(), ...body }
        try {
          writeBootReport(dshHome, report)
        } catch (error) {
          ctx.logger.warn(`dsh-boot-animation-sound: could not write the boot report (${error.code ?? error.message})`)
        }
        ctx.logger.info(`dsh-boot-animation-sound: boot report audio=${String(report.audio)} muted=${String(report.muted)} fullscreen=${String(report.fullscreen)} audioBytes=${String(report.audioDecodedBytes)}`)
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({ ok: true }))
      },
    }))

    scoped.effect(() => scoped.webServer.register({
      kind: 'prefix',
      path: MEDIA_ROUTE,
      handler: (req, res) => {
        if (guard(req, res)) return
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { Allow: 'GET, HEAD' })
          res.end()
          return
        }
        const media = resolveMedia(settings().src, dshHome)
        if (!playable(media)) {
          notFound(res)
          return
        }
        let requested
        try {
          requested = decodeURIComponent(String(req.url ?? '').slice(MEDIA_ROUTE.length).replace(/^\//, '').split('?')[0])
        } catch {
          notFound(res)
          return
        }
        // Only the file that is configured right now is ever served.
        if (requested !== media.name) {
          notFound(res)
          return
        }
        serveMedia(req, res, media)
      },
    }))
  })
}

export { BUNDLED_MEDIA, CONFIG_ROUTE, MEDIA_ROUTE, PICK_ROUTE, REPORT_ROUTE, ROUTE_BASE, SAVE_ROUTE, STATE_DIRNAME }
