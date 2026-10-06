/**
 * dsh-boot-animation-sound — bundled-media verification.
 *
 * The headline feature is SOUND, so a bundled clip that carries no audio track
 * would ship a plugin that cannot do the one thing it exists for. That is not a
 * cosmetic defect and it is invisible until someone plays the clip, so it is
 * checked here rather than assumed.
 *
 * Reports every file in `media/`, then requires the clip the plugin actually
 * resolves by default to exist and to contain a 'soun' track with a known audio
 * sample entry.
 *
 * No dependencies. `node verify/check-media.mjs`.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BUNDLED_MEDIA } from '../index.js'

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))
const MEDIA_DIR = join(PACKAGE_DIR, 'media')

/** ISO-BMFF track handler types. */
const AUDIO_HANDLER = 'soun'
const VIDEO_HANDLER = 'vide'
/** Sample-entry fourccs that mean "there is audio to decode". */
const AUDIO_SAMPLE_ENTRIES = ['mp4a', 'Opus', 'opus', 'ac-3', 'ec-3', 'alac', 'twos', 'sowt', '.mp3', 'vorb', 'fLaC']

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

/**
 * Inspect one container for the tracks it declares.
 * @param path - absolute path of the media file.
 * @returns the handler/sample-entry findings.
 */
function inspect(path) {
  const text = readFileSync(path).toString('latin1')
  return {
    bytes: statSync(path).size,
    video: text.includes(VIDEO_HANDLER),
    audio: text.includes(AUDIO_HANDLER),
    entries: AUDIO_SAMPLE_ENTRIES.filter((fourcc) => text.includes(fourcc)),
  }
}

console.log('\n[1] everything in media/')
let files = []
try {
  files = readdirSync(MEDIA_DIR).filter((name) => /\.(mp4|m4v|webm|mov|mkv|ogv)$/i.test(name)).sort()
} catch (error) {
  console.log(`  (media/ is missing: ${error.code})`)
}
for (const name of files) {
  const found = inspect(join(MEDIA_DIR, name))
  console.log(`  ${name}: ${(found.bytes / 1024 / 1024).toFixed(2)} MB · video=${found.video} · audio=${found.audio} [${found.entries.join(', ')}]`)
}
check('at least one clip is bundled', files.length > 0, `found ${files.length}`)

console.log('\n[2] the clip the plugin plays by default')
// Split on either separator: the suite runs on Windows and on the Linux CI runner.
const name = BUNDLED_MEDIA.split(/[\\/]/).pop()
console.log(`  resolves to: ${BUNDLED_MEDIA}`)
let bundled = null
try {
  bundled = inspect(BUNDLED_MEDIA)
} catch (error) {
  check('the default clip exists', false, `${name}: ${error.code}`)
}
if (bundled !== null) {
  check('the default clip exists', true)
  check('the default clip is a video container', bundled.video)
  check('the default clip carries an audio track', bundled.audio)
  check('the audio track uses a known sample entry', bundled.entries.length > 0, `entries=[${bundled.entries.join(', ')}]`)
  check('the default clip is small enough to ship', bundled.bytes < 32 * 1024 * 1024, `${(bundled.bytes / 1024 / 1024).toFixed(2)} MB`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.error(`${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('all good')
