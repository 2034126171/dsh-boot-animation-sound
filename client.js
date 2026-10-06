/**
 * dsh-boot-animation-sound — browser half.
 *
 * Hand-written client bundle in the DSH client-module form: executing this file
 * only REGISTERS a lazy factory (`window.__ModuleLoader__.load`); every side
 * effect lives inside the factory closure and runs at materialization. No
 * bundler is involved, which is what keeps the package installable without a
 * build step.
 *
 * Two registrations:
 *   - `shell.overlay` — the animation, mounted as a portal on `<body>` so no
 *     stacking context can trap it under another plugin's overlay.
 *   - `settings.plugins.tab` — the page with the sound switch.
 *
 * THE POINT OF THIS PACKAGE
 * -------------------------
 * Sound must not cost a full screen. So:
 *
 *   - `requestFullscreen()` appears in exactly ONE place: the handler of the
 *     optional full-screen button, which is off by default. Turning the sound on
 *     cannot reach it.
 *   - The clip is asked to play AUDIBLY first. Where the platform allows that
 *     (see the Host half's module doc), the animation has sound with no click at
 *     all.
 *   - Where the platform refuses — which is what this machine measurably does —
 *     the clip restarts muted so the animation always plays, and the sound comes
 *     on at the first click or key press ANYWHERE, in place, at the same window
 *     size. A small chip says so, and skipping is a separate gesture.
 *
 * The outcome of every real boot is posted to the Host
 * (`POST /dsh-boot-animation-sound/report`), which writes it to
 * `<DSH_HOME>/dsh-boot-animation-sound/last-boot.json` and shows it in the
 * settings page. That record is how "did it have sound" is answered without
 * guessing: `audioDecodedBytes > 0` means an audio track was actually decoded
 * and fed to the output, and `fullscreen` records whether anything took the
 * screen.
 *
 * Copyright (c) 2026 LSY (个人创作). MIT licensed — see LICENSE.
 *
 * @module dsh-boot-animation-sound/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-boot-animation-sound',
  factory(require) {
    const React = require('react')
    const { createPortal } = require('react-dom')

    /** Alias for `React.createElement`; this file is transformed by no build step. */
    const h = React.createElement

    const BASE = '/dsh-boot-animation-sound'
    const CONFIG_URL = `${BASE}/config.json`
    const SAVE_URL = `${BASE}/config`
    const PICK_URL = `${BASE}/pick`
    const REPORT_URL = `${BASE}/report`
    const CLAIM_URL = `${BASE}/claim`
    const RESET_URL = `${BASE}/reset`
    const OVERLAY_SLOT = 'shell.overlay'
    const TAB_SLOT = 'settings.plugins.tab'
    const ROW_ID = 'dsh-boot-animation-sound'

    /** Triggers that fire on a page load, where the Host decides the occasion. */
    const PAGE_TRIGGERS = new Set(['appStart', 'pageRefresh'])
    /** Triggers that fire on a conversation action, watched in the browser. */
    const CONVERSATION_TRIGGERS = new Set(['newConversation', 'anySession'])

    /**
     * The stacking level of the animation.
     *
     * A `position: fixed` element with `z-index: auto` sits at level 0 of the
     * root stacking context and is painted over by anything positioned with a
     * positive z-index, and other plugins mount body-level overlays in the
     * thousands. Portalling to `<body>` puts this in the root context, where the
     * number finally means what it says.
     */
    const TOP_Z = 2147483000

    /** Markers inside the Host's rules, used to find and remove that style element. */
    const COVER_MARKERS = ['dsh-boot-animation-sound-cover', 'dsh-boot-animation-sound-base']

    /** Guards the release so it cannot run twice. */
    let coverReleased = false

    /**
     * Drop the Host's cover and its dark base colour, revealing the application.
     *
     * Both go together: the base colour is only correct while the animation owns
     * the screen, and leaving it behind would repaint the whole application black
     * on a light theme.
     *
     * Removing the element is what makes the release ONE-WAY. A release that a
     * selector re-evaluates re-arms as soon as the animation unmounts, and then
     * the interface stays hidden for good.
     */
    function releaseCover() {
      if (coverReleased || typeof document === 'undefined') return
      coverReleased = true
      try {
        // Disarm the Host's watchdog first: it exists only for the case where this
        // module never runs, and once the release has happened it has nothing left
        // to do.
        const guard = globalThis.__DSH_BOOT_SOUND_COVER_GUARD__
        if (guard !== undefined && guard !== null && typeof guard.clear === 'function') guard.clear()
      } catch { /* an absent guard is the normal case when the Host injected none */ }
      try {
        const sheets = document.head ? document.head.getElementsByTagName('style') : []
        // Collected first: removing while iterating a live collection skips
        // elements.
        for (let i = 0; i < sheets.length; i += 1) {
          const node = sheets[i]
          const text = typeof node.textContent === 'string' ? node.textContent : ''
          if (!COVER_MARKERS.some((marker) => text.includes(marker))) continue
          if (typeof node.remove === 'function') node.remove()
          else if (node.parentNode) node.parentNode.removeChild(node)
        }
      } catch { /* revealing the application must never throw */ }
    }

    /**
     * Whether THIS page load is the one the animation belongs to.
     *
     * A boot animation must run at BOOT. DSH's client-module graph is live: enabling
     * this plugin, or the client HMR channel adding the module, loads this file into
     * a page that may have been open for hours — and dropping a full-screen clip over
     * a working session is not what "boot animation" means.
     *
     * The Host's first-paint cover is the precise signal. It is injected into the
     * served HTML only for a page load the Host decided to cover, and it is present
     * in `<head>` by the time any client module runs, on that load alone.
     *
     * With the cover switched off (`coverApplication: false`) freshness of the
     * document is the fallback: a module that arrives minutes into a page's life
     * cannot be joining a boot.
     *
     * @returns true when the animation should take the screen.
     */
    function belongsToThisPageLoad() {
      if (typeof document === 'undefined' || typeof performance === 'undefined') return true
      try {
        const sheets = document.head ? document.head.getElementsByTagName('style') : []
        for (let i = 0; i < sheets.length; i += 1) {
          const text = typeof sheets[i].textContent === 'string' ? sheets[i].textContent : ''
          if (COVER_MARKERS.some((marker) => text.includes(marker))) return true
        }
      } catch { /* an unreadable head simply means "no cover"; freshness decides */ }
      return performance.now() < 20000
    }

    /**
     * Watch the conversation actions, for the `newConversation` and `anySession`
     * triggers.
     *
     * The client event catalogue has no session event at all — it is
     * `connection/reset`, `locale/change`, `slots/changed` and `theme/change` — so
     * the only honest way to notice "the user opened a conversation" is to wrap the
     * service the interface calls to do it.
     *
     * The wrapper is deliberately conservative, because a hook that breaks
     * navigation is worse than a trigger that never fires:
     *
     *   - the original is called FIRST, with the same receiver, and its result is
     *     returned unchanged, so the action behaves identically even if the
     *     notification throws;
     *   - assignment is verified (a frozen or accessor-only service simply ends up
     *     unwrapped);
     *   - the returned disposer restores every method it changed, and only if the
     *     property still holds this wrapper.
     *
     * @param ctx - the plugin context, asked for the workspace service.
     * @param report - called with the occasion that just happened.
     * @returns a disposer for every wrapper installed.
     */
    function watchConversations(ctx, report) {
      let workspace
      try {
        workspace = ctx.get('uiWorkspace')
      } catch {
        workspace = undefined
      }
      if (workspace === null || typeof workspace !== 'object') return () => {}
      const restores = []
      const wrap = (method, occasion) => {
        const original = workspace[method]
        if (typeof original !== 'function') return
        const wrapped = function (...args) {
          const result = original.apply(this, args)
          try {
            report(occasion)
          } catch { /* a failed trigger must never break navigation */ }
          return result
        }
        try {
          workspace[method] = wrapped
        } catch {
          return
        }
        if (workspace[method] !== wrapped) return
        restores.push(() => {
          try {
            if (workspace[method] === wrapped) workspace[method] = original
          } catch { /* the service was replaced underneath us */ }
        })
      }
      // Starting or connecting a conversation is a NEW conversation; opening one is
      // just a session becoming visible.
      wrap('startSession', 'newConversation')
      wrap('connectWorkspace', 'newConversation')
      wrap('openSession', 'sessionOpen')
      return () => {
        for (const restore of restores) restore()
      }
    }

    /** @returns the interface language, so the boot screen follows the OS. */
    function locale() {
      try {
        const tag = String(navigator.language || '')
        if (tag.toLowerCase().startsWith('zh')) return 'zh'
      } catch { /* a browser without navigator.language is not worth failing over */ }
      return 'en'
    }

    const TEXT = {
      zh: {
        tab: '开机动画',
        heading: '开机动画（免全屏出声）',
        intro: '启动时播放一段视频。声音不需要全屏：能直接出声就直接出声，被系统拦下时，点一下窗口任意位置即可开声，窗口大小不变。',
        soundLabel: '播放影片声音',
        soundHint: '关掉＝整段动画静音，也不再出现开声提示；打开＝先尝试带声音起播。',
        volumeLabel: '音量',
        firstInputLabel: '首次点击/按键自动开声',
        firstInputHint: '打开后，动画期间第一次点鼠标或按键盘就会开声（不会进入全屏）。关掉则只能点右下角的开声按钮。',
        enabledLabel: '启动时显示动画',
        skipLabel: '退出方式',
        skipButton: '右下角按钮',
        skipClick: '点任意位置',
        skipAuto: '自动退出',
        skipNever: '不能退出',
        fsLabel: '显示全屏按钮',
        fsHint: '默认关闭。与声音完全无关：开声永远不会触发它。',
        pathLabel: '视频文件',
        choose: '选择文件…',
        save: '保存',
        clear: '清除（不再播放）',
        saved: '已保存',
        picking: '正在等待文件对话框…',
        current: '当前',
        bundled: '插件自带视频',
        willPlay: '下次启动播放',
        none: '不播放',
        tabHint: '清空路径后，DSH 启动与没装这个插件时完全一样。',
        lastBoot: '最近一次启动的声音记录',
        noRecord: '还没有记录。启动一次 DSH 后这里会显示实际结果。',
        triggerLabel: '触发时机',
        triggers: {
          appStart: '启动应用',
          pageRefresh: '页面刷新',
          newConversation: '新对话',
          anySession: '任意会话',
        },
        triggerHint: '启动应用＝一次运行里只算第一次页面加载；页面刷新＝每次页面加载都算；新对话＝新建对话时；任意会话＝打开任意对话时（含新建）。',
        frequencyLabel: '播放频率',
        frequencies: {
          every: '每次',
          daily: '每天一次',
          once: '只播一次',
          times: '限播 N 次',
        },
        frequencyHint: '计数存在 DSH 的状态目录里，按本机累计：刷新页面、开第二个窗口、重启 DSH 都算在同一份账上。',
        maxPlaysLabel: '限播次数',
        ledgerLabel: '播放账本',
        ledgerNever: '还没播放过',
        resetLedger: '重置计数',
        resetDone: '计数已重置',
        denied: {
          disabled: '动画已关闭',
          'no-media': '没有可播放的视频',
          trigger: '触发时机不匹配',
          daily: '今天已经播过了',
          once: '「只播一次」已经用掉了',
          times: '「限播 N 次」已经用完了',
          ledger: '计数写入失败，这次不播',
        },
        probs: {
          'missing-file': '文件不存在',
          'unreadable-file': '文件无法读取',
          'not-a-file': '这个路径不是文件',
          'unsupported-format': '不支持的格式',
          'file-too-large': '文件太大',
          'load-failed': '读取设置失败',
          'picker-unavailable': '这台机器打不开文件对话框，请直接把路径粘进输入框',
          'write-failed': '保存失败',
        },
        audioStates: {
          on: '有声播放中',
          off: '已按设置静音',
          blocked: '被系统拦下，点一下窗口任意位置开声（不需要全屏）',
          error: '视频播放失败',
          pending: '准备中',
        },
        chip: '🔊 点这里开声（不用全屏）',
        chipOn: '🔊 声音已开',
        skip: '跳过',
        fullscreen: '全屏',
        loading: '正在加载视频…',
        stalled: '视频加载超时',
        failed: '视频加载失败',
      },
      en: {
        tab: 'Boot animation',
        heading: 'Boot animation (sound without full screen)',
        intro: 'Plays a clip at startup. Sound does not require full screen: it tries to start audibly, and where the platform refuses, the first click anywhere turns it on at the same window size.',
        soundLabel: 'Play the clip with sound',
        soundHint: 'Off silences the animation completely and offers no sound affordance. On tries to start audibly first.',
        volumeLabel: 'Volume',
        firstInputLabel: 'Sound on first click or key press',
        firstInputHint: 'The first click or key press during the animation turns the sound on, without entering full screen. Off leaves the chip as the only way in.',
        enabledLabel: 'Show the animation at startup',
        skipLabel: 'Dismiss',
        skipButton: 'Button',
        skipClick: 'Click anywhere',
        skipAuto: 'Automatically',
        skipNever: 'Never',
        fsLabel: 'Show a full-screen button',
        fsHint: 'Off by default, and unrelated to sound: turning sound on never triggers it.',
        pathLabel: 'Video file',
        choose: 'Choose file…',
        save: 'Save',
        clear: 'Clear (stop playing)',
        saved: 'Saved',
        picking: 'Waiting for the file dialog…',
        current: 'Current',
        bundled: 'Bundled clip',
        willPlay: 'Plays on next start',
        none: 'Nothing',
        tabHint: 'With the path cleared, DSH starts exactly as it would without this plugin.',
        lastBoot: 'Last boot, as recorded',
        noRecord: 'No record yet. It appears after one DSH start.',
        triggerLabel: 'Trigger',
        triggers: {
          appStart: 'Application start',
          pageRefresh: 'Page load',
          newConversation: 'New conversation',
          anySession: 'Any conversation',
        },
        triggerHint: 'Application start counts only the first page load of one run; page load counts every one; the conversation triggers fire when a conversation is started or opened.',
        frequencyLabel: 'Frequency',
        frequencies: {
          every: 'Every time',
          daily: 'Once a day',
          once: 'Only once',
          times: 'At most N times',
        },
        frequencyHint: 'Counted per machine, in the DSH state directory: a refresh, a second window and a restart all draw on the same ledger.',
        maxPlaysLabel: 'Times allowed',
        ledgerLabel: 'Play ledger',
        ledgerNever: 'Never played yet',
        resetLedger: 'Reset the count',
        resetDone: 'Count reset',
        denied: {
          disabled: 'The animation is switched off',
          'no-media': 'No playable video',
          trigger: 'This occasion does not match the trigger',
          daily: 'Already played today',
          once: 'The "only once" budget is spent',
          times: 'The "at most N times" budget is spent',
          ledger: 'The ledger could not be written, so nothing played',
        },
        probs: {
          'missing-file': 'The file does not exist',
          'unreadable-file': 'The file cannot be read',
          'not-a-file': 'That path is not a file',
          'unsupported-format': 'Unsupported format',
          'file-too-large': 'The file is too large',
          'load-failed': 'Could not read the settings',
          'picker-unavailable': 'This host has no file dialog; paste the path into the field',
          'write-failed': 'Could not save',
        },
        audioStates: {
          on: 'Playing with sound',
          off: 'Muted by setting',
          blocked: 'Refused by the platform — click anywhere for sound, no full screen needed',
          error: 'Playback failed',
          pending: 'Preparing',
        },
        chip: '🔊 Click for sound (no full screen)',
        chipOn: '🔊 Sound on',
        skip: 'Skip',
        fullscreen: 'Full screen',
        loading: 'Loading video…',
        stalled: 'The video timed out',
        failed: 'The video failed to load',
      },
    }

    /** @returns the string table for the active language. */
    const strings = () => TEXT[locale()]

    /** @returns the element placed in the root stacking context. */
    function topLayer(node) {
      if (typeof document === 'undefined' || document.body === null) return node
      return createPortal(node, document.body)
    }

    /** Fetch the Host's effective settings and media descriptor. */
    async function loadConfig() {
      try {
        const response = await fetch(CONFIG_URL, { credentials: 'same-origin', cache: 'no-store' })
        if (!response.ok) return { settings: {}, media: { kind: 'none' }, problem: 'load-failed' }
        return await response.json()
      } catch {
        return { settings: {}, media: { kind: 'none' }, problem: 'load-failed' }
      }
    }

    /** Post one JSON body to a Host route; failures are never fatal. */
    async function post(url, body) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        })
        if (!response.ok) return { ok: false, error: `http-${response.status}` }
        return await response.json()
      } catch (error) {
        return { ok: false, error: String(error && error.message ? error.message : error) }
      }
    }

    /** Clamp a number into `[min, max]`, falling back when it is not a number. */
    function num(value, fallback, min, max) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
      return Math.min(Math.max(value, min), max)
    }

    /**
     * Ask the Host whether the animation may play now.
     *
     * The Host answers with the trigger match AND the frequency budget already
     * applied, and SPENDS one play when the answer is yes. Keeping that decision
     * on one side is what makes the ledger trustworthy: a browser-side counter
     * would be per-window, and would forget on a refresh.
     *
     * @param occasion - `appStart`, `pageRefresh`, `newConversation` or `sessionOpen`.
     * @returns the Host's verdict, or `null` when it could not be reached.
     */
    async function claim(occasion) {
      const answer = await post(CLAIM_URL, { occasion })
      return answer !== null && typeof answer === 'object' ? answer : null
    }

    /**
     * The "play now" signal, shared by the animation component and the
     * conversation watchers.
     *
     * A monotonic nonce rather than a flag: a conversation trigger can fire again
     * after the animation has already finished, and each occasion needs its own
     * replay. Watchers only ever bump it; the component subscribes.
     */
    const playStore = {
      nonce: 0,
      listeners: new Set(),
      /** Ask for a play, and tell every subscriber. */
      request() {
        playStore.nonce += 1
        for (const listener of [...playStore.listeners]) {
          try {
            listener(playStore.nonce)
          } catch { /* one bad listener must not stop the others */ }
        }
      },
      /** @returns a disposer. */
      subscribe(listener) {
        playStore.listeners.add(listener)
        return () => playStore.listeners.delete(listener)
      },
    }

    /** @returns the CSS `object-fit` for a configured fit mode. */
    function objectFit(fit) {
      return fit === 'contain' ? 'contain' : fit === 'fill' ? 'fill' : 'cover'
    }

    /**
     * Whether this browser decoded any audio from the element.
     *
     * Chromium exposes a decoded-byte counter that only advances when the audio
     * pipeline actually runs, which distinguishes "the element says it is not
     * muted" from "sound is really being produced". It is what the boot report
     * uses to prove the clip carries audio.
     *
     * @param video - the media element.
     * @returns the byte count, or `null` when the browser exposes no counter.
     */
    function audioDecodedBytes(video) {
      const value = video.webkitAudioDecodedByteCount
      return typeof value === 'number' && Number.isFinite(value) ? value : null
    }

    /** The animation. Renders nothing at all while no clip is configured. */
    function BootAnimation() {
      const t = strings()
      const videoRef = React.useRef(null)
      const audioRef = React.useRef('pending')
      const closedRef = React.useRef(false)
      const fullscreenAskedRef = React.useRef(false)
      const [config, setConfig] = React.useState(null)
      const [phase, setPhase] = React.useState('loading')
      const [audio, setAudio] = React.useState('pending')
      const [fading, setFading] = React.useState(false)
      const [progress, setProgress] = React.useState(0)
      const [remaining, setRemaining] = React.useState(null)
      /** Which play request produced the current run; `0` means none yet. */
      const [nonce, setNonce] = React.useState(0)
      /** The request that has already finished, so a NEW one can start again. */
      const [doneNonce, setDoneNonce] = React.useState(-1)
      const nonceRef = React.useRef(0)
      nonceRef.current = nonce

      /** Keep the ref and the state in step, so listeners read a fresh value. */
      const setAudioState = React.useCallback((next) => {
        audioRef.current = next
        setAudio(next)
      }, [])

      // One play request, from either source: this component's own page-load
      // claim, or a conversation watcher bumping the shared store.
      React.useEffect(() => playStore.subscribe(setNonce), [])

      React.useEffect(() => {
        let cancelled = false
        loadConfig().then((result) => {
          if (!cancelled) setConfig(result)
        })
        return () => {
          cancelled = true
        }
      }, [])

      const settings = (config && config.settings) || {}
      const media = (config && config.media) || { kind: 'none' }
      // Evaluated ONCE, on the first render: `releaseCover()` deliberately removes
      // the very marker this reads, so re-evaluating it would switch the animation
      // off the moment it painted its first frame.
      const fresh = React.useRef(null)
      if (fresh.current === null) fresh.current = belongsToThisPageLoad()

      /** There is a clip, it is playable, and the settings allow showing it. */
      const ready = config !== null && settings.enabled === true && media.kind === 'video' && !(config.problem)

      /**
       * Ask the Host for this page load's play, and take the cover off when the
       * answer is no.
       *
       * The occasion is the Host's own verdict (`appStart` for the first index
       * render of the run, `pageRefresh` for every later one) rather than anything
       * guessed here, so a trigger cannot disagree with the cover decision that was
       * already made from the same counters.
       */
      React.useEffect(() => {
        if (config === null) return undefined
        let cancelled = false
        const pageTriggers = PAGE_TRIGGERS.has(settings.trigger)
        // Nothing plays on this page load for a conversation trigger, and a module
        // that arrived after the page load has no page load of its own to join.
        if (!ready || !pageTriggers || fresh.current !== true) {
          releaseCover()
          return undefined
        }
        claim(config.pageOccasion).then((answer) => {
          if (cancelled) return
          if (answer !== null && answer.play === true) playStore.request()
          else releaseCover()
        })
        return () => {
          cancelled = true
        }
      }, [config, ready, settings.trigger])

      /** A play was claimed for the current request. */
      const active = ready && nonce > 0

      /**
       * Whether the animation is on screen RIGHT NOW.
       *
       * `active` says "a play was claimed"; `running` adds "and it has not
       * finished". The distinction is the whole reason this variable exists, and
       * getting it wrong is not cosmetic:
       *
       * A slot registry keeps the component MOUNTED for the life of the page, so
       * "the animation is over" has to be a RENDER decision — not an unmount, and
       * not just a lower opacity. A `position: fixed; inset: 0` box that is merely
       * transparent still swallows every click in the application, which is
       * exactly the lockout this guards against: the interface looked normal, and
       * nothing responded.
       *
       * Every effect below is gated on `running` for the same reason: returning
       * null does NOT unmount the component, so effects keep running and their
       * cleanups never fire unless a dependency changes.
       */
      const running = active && doneNonce !== nonce

      /** Post what actually happened, once per concern rather than per frame. */
      const report = React.useCallback((why) => {
        const video = videoRef.current
        post(REPORT_URL, {
          why,
          audio: audioRef.current,
          wantSound: settings.sound === true,
          muted: video === null ? null : video.muted,
          volume: video === null ? null : video.volume,
          paused: video === null ? null : video.paused,
          readyState: video === null ? null : video.readyState,
          duration: video !== null && Number.isFinite(video.duration) ? Math.round(video.duration * 100) / 100 : null,
          videoWidth: video === null ? null : video.videoWidth,
          videoHeight: video === null ? null : video.videoHeight,
          audioDecodedBytes: video === null ? null : audioDecodedBytes(video),
          decodedFrames: video === null || typeof video.webkitDecodedFrameCount !== 'number' ? null : video.webkitDecodedFrameCount,
          fullscreen: typeof document !== 'undefined' && document.fullscreenElement !== null,
          fullscreenEverRequested: fullscreenAskedRef.current,
          userActivation: typeof navigator !== 'undefined' && navigator.userActivation
            ? { isActive: navigator.userActivation.isActive, hasBeenActive: navigator.userActivation.hasBeenActive }
            : null,
          mediaName: media.name ?? null,
          mediaSource: config === null ? null : config.source ?? null,
          problem: config === null ? null : config.problem ?? null,
          ua: typeof navigator === 'undefined' ? null : navigator.userAgent,
        })
      }, [config, media.name, settings.sound])

      const close = React.useCallback(() => {
        if (closedRef.current) return
        closedRef.current = true
        report('closed')
        const video = videoRef.current
        if (video !== null) {
          try {
            video.pause()
            // Detaching is what actually stops the audio. The effect below is
            // also cleaned up when `running` flips, but a skip must silence the
            // clip at once rather than at the next commit.
            video.removeAttribute('src')
            video.load()
          } catch { /* already stopped */ }
        }
        releaseCover()
        setPhase('done')
        // Which request finished. A LATER request has a different nonce, so the
        // animation can run again for the next occasion instead of being spent.
        setDoneNonce(nonceRef.current)
      }, [report])

      /** Fade out and then leave, holding the last frame for the configured pause. */
      const finish = React.useCallback(() => {
        if (closedRef.current) return
        const hold = num(settings.holdAfterEndMs, 120, 0, 60000)
        const fade = num(settings.fadeOutMs, 360, 0, 10000)
        window.setTimeout(() => {
          if (closedRef.current) return
          setFading(true)
          window.setTimeout(() => close(), fade)
        }, hold)
      }, [close, settings.holdAfterEndMs, settings.fadeOutMs])

      /**
       * Turn the sound on for the clip that is already playing.
       *
       * The gesture has already happened by the time this runs, so the unmuted
       * play succeeds where the initial attempt was refused. This is the whole
       * difference from the reference plugin: it unmutes here and does nothing
       * else — no `requestFullscreen()`, no size change, no navigation.
       *
       * @returns true when this call was the one that unlocked the sound.
       */
      const unlock = React.useCallback(() => {
        const video = videoRef.current
        if (video === null || audioRef.current !== 'blocked') return false
        video.muted = false
        const settle = () => {
          const ok = video.muted === false && !video.paused
          setAudioState(ok ? 'on' : 'blocked')
          report(ok ? 'unlocked' : 'unlock-refused')
        }
        const attempt = video.play()
        if (attempt !== undefined && typeof attempt.then === 'function') {
          attempt.then(settle, () => {
            video.muted = true
            setAudioState('blocked')
            report('unlock-refused')
          })
        } else {
          settle()
        }
        return true
      }, [report, setAudioState])

      // The clip: point the element at the configured resource, ask for sound
      // first, and fall back to a muted start so the animation is never lost to
      // the autoplay policy.
      React.useEffect(() => {
        if (!running) return undefined
        const video = videoRef.current
        if (video === null) return undefined
        closedRef.current = false
        setPhase('loading')
        setFading(false)
        setProgress(0)

        const wantSound = settings.sound === true
        video.playbackRate = num(settings.playbackRate, 1, 0.1, 4)
        video.volume = num(settings.volume, 0.9, 0, 1)
        // Set BEFORE the first play(): the element must already be in the state
        // the policy is asked about, otherwise a React re-render could flip it
        // after playback has begun.
        video.muted = !wantSound

        let cancelled = false
        const timers = []
        const after = (ms, run) => {
          const id = window.setTimeout(run, ms)
          timers.push(id)
          return id
        }

        const onPlaying = () => {
          if (cancelled) return
          setPhase('playing')
          releaseCover()
          // The audio decision lands one microtask AFTER `play()` settles, so a
          // report taken here would record `pending` — and that first report is
          // the one that answers "did it have sound". `begin()` reports the
          // decision itself; this only reports when it is already known, and the
          // delayed report catches the case where audio started late.
          if (audioRef.current !== 'pending') report('playing')
          after(1500, () => {
            if (!cancelled && !closedRef.current) report('settled')
          })
        }
        const onTimeUpdate = () => {
          if (cancelled) return
          const total = video.duration
          setProgress(Number.isFinite(total) && total > 0 ? Math.min(1, video.currentTime / total) : 0)
        }
        const onEnded = () => {
          if (cancelled) return
          const replays = Number(video.dataset.replays || '0')
          const allowed = num(settings.maxReplays, 0, 0, 100)
          if (replays < allowed) {
            video.dataset.replays = String(replays + 1)
            video.currentTime = 0
            const again = video.play()
            if (again !== undefined && typeof again.catch === 'function') again.catch(() => {})
            return
          }
          finish()
        }
        const onError = () => {
          if (cancelled) return
          setPhase('error')
          report('error')
          after(1200, () => {
            if (!cancelled) close()
          })
        }
        video.addEventListener('playing', onPlaying)
        video.addEventListener('timeupdate', onTimeUpdate)
        video.addEventListener('ended', onEnded)
        video.addEventListener('error', onError)

        video.src = media.url
        video.load()

        /** Start the clip, audibly when asked, and muted only as the fallback. */
        const begin = async () => {
          try {
            await video.play()
            if (cancelled) return
            setAudioState(wantSound ? 'on' : 'off')
            report('started')
            return
          } catch (error) {
            if (!wantSound) {
              if (!cancelled) {
                setAudioState('error')
                setPhase('error')
                report(`play-failed:${error && error.name ? error.name : 'unknown'}`)
              }
              return
            }
          }
          // Audible playback was refused. That is the expected answer on a strict
          // autoplay policy, and it must not cost the animation: the picture
          // plays muted and the sound is left to a gesture.
          video.muted = true
          try {
            await video.play()
            if (cancelled) return
            setAudioState('blocked')
            report('refused-unmuted')
          } catch (error) {
            if (!cancelled) {
              setAudioState('error')
              setPhase('error')
              report(`play-failed-muted:${error && error.name ? error.name : 'unknown'}`)
            }
          }
        }
        begin()

        // A clip that never reaches its first frame must not hold the screen.
        after(12000, () => {
          if (cancelled || closedRef.current) return
          if (video.readyState < 2) {
            setPhase('stalled')
            report('stalled')
            close()
          }
        })

        /**
         * The backstop that guarantees the interface comes back.
         *
         * Every normal exit (ended, `duration`, a media error, the stall guard) is
         * armed elsewhere and fires first. This one exists because the failure it
         * prevents is the worst possible one — an unusable application — and a
         * single missed event must not be able to cause it. Ten minutes is longer
         * than any boot clip and shorter than "I had to restart DSH".
         */
        after(600000, () => {
          if (cancelled || closedRef.current) return
          report('ceiling')
          close()
        })

        // A clip whose length is known but which never reports an end.
        const armDuration = () => {
          const limit = num(settings.duration, 0, 0, 600000)
          if (limit > 0) {
            after(limit, () => {
              if (!cancelled) close()
            })
            return
          }
          if (Number.isFinite(video.duration) && video.duration > 0) {
            after(video.duration * 1000 + 4000, () => {
              if (!cancelled && !video.ended) close()
            })
            return
          }
          // A length that is missing or infinite (a stream, a broken container)
          // gives nothing to arm from, so bound it explicitly.
          after(600000, () => {
            if (!cancelled) close()
          })
        }
        video.addEventListener('loadedmetadata', armDuration)
        if (video.readyState >= 1) armDuration()

        return () => {
          cancelled = true
          for (const id of timers) window.clearTimeout(id)
          video.removeEventListener('playing', onPlaying)
          video.removeEventListener('timeupdate', onTimeUpdate)
          video.removeEventListener('ended', onEnded)
          video.removeEventListener('error', onError)
          video.removeEventListener('loadedmetadata', armDuration)
          // Detaching a <video> does not stop media by itself, and the element
          // outlives this component in the slot's registry.
          try {
            video.pause()
            video.removeAttribute('src')
            video.load()
          } catch { /* a detached media element can throw; nothing is left to release */ }
        }
      }, [running, nonce, config, media.url, settings.sound, settings.volume, settings.playbackRate, settings.duration, settings.maxReplays, close, finish, report, setAudioState])

      // Sound at the first click or key press ANYWHERE. Capture phase, and
      // deliberately silent: it stops nothing, prevents nothing and never changes
      // the window size, so the click still reaches whatever the user aimed at.
      React.useEffect(() => {
        if (!running || audio !== 'blocked') return undefined
        if (settings.soundOnFirstInput !== true) return undefined
        const handler = () => {
          unlock()
        }
        window.addEventListener('pointerdown', handler, true)
        window.addEventListener('touchstart', handler, true)
        window.addEventListener('keydown', handler, true)
        return () => {
          window.removeEventListener('pointerdown', handler, true)
          window.removeEventListener('touchstart', handler, true)
          window.removeEventListener('keydown', handler, true)
        }
      }, [running, audio, settings.soundOnFirstInput, unlock])

      // `skip: auto` and the countdown that appears with it.
      React.useEffect(() => {
        if (!running) return undefined
        if (settings.skip !== 'auto') return undefined
        const delay = num(settings.skipAfterMs, 1500, 0, 60000)
        const id = window.setTimeout(() => close(), delay)
        return () => window.clearTimeout(id)
      }, [running, settings.skip, settings.skipAfterMs, close])

      /**
       * The keyboard exit.
       *
       * Escape is armed whenever the animation runs, in EVERY skip mode, and that
       * is deliberate: it is the emergency exit. A full-screen surface that cannot
       * be dismissed is one bug away from an unusable application, and a key press
       * is the input that keeps working when a stray overlay is eating clicks.
       * Space and Enter stay governed by the configured mode, so `skip: never`
       * still means "no obvious way out" — just not "no way out at all".
       */
      React.useEffect(() => {
        if (!running) return undefined
        const interactive = settings.skip === 'button' || settings.skip === 'click'
        const onKey = (event) => {
          const key = String(event.key || '')
          const escape = key === 'Escape'
          if (key !== 'Escape' && key !== ' ' && key !== 'Enter') return
          if (!escape && !interactive) return
          const node = document.activeElement
          const tag = node === null || node === undefined ? '' : String(node.tagName || '')
          if (!escape && (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT')) return
          event.preventDefault()
          close()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [running, settings.skip, close])

      // The countdown display for entry modes that show one.
      React.useEffect(() => {
        if (!running || settings.skip !== 'auto') {
          setRemaining(null)
          return undefined
        }
        const seconds = Math.ceil(num(settings.skipAfterMs, 1500, 0, 60000) / 1000)
        setRemaining(seconds > 0 ? seconds : null)
        return undefined
      }, [running, settings.skip, settings.skipAfterMs])

      React.useEffect(() => () => {
        releaseCover()
      }, [])

      // Nothing may be painted once the animation is over. See `running`.
      if (!running) return null

      /** One click on the animation: buy the sound first, dismiss secondarily. */
      const onRootClick = () => {
        if (audio === 'blocked' && settings.soundOnFirstInput === true) {
          // This click is the gesture the audio policy wanted. Spending it on
          // "leave" would make the sound audible only on the way out.
          unlock()
          return
        }
        if (settings.skip === 'click') close()
      }

      const askFullscreen = () => {
        const video = videoRef.current
        if (video === null || typeof video.requestFullscreen !== 'function') return
        fullscreenAskedRef.current = true
        // The ONLY call to requestFullscreen in this package, reachable only from
        // the button below.
        video.requestFullscreen().catch(() => {})
      }

      const statusText = phase === 'error'
        ? (config && config.problem ? (t.probs[config.problem] ?? t.failed) : t.failed)
        : phase === 'stalled' ? t.stalled : t.loading

      return topLayer(h(
        'div',
        {
          className: 'dbas-root',
          onClick: onRootClick,
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: TOP_Z,
            background: typeof settings.background === 'string' ? settings.background : '#000000',
            opacity: fading ? 0 : 1,
            // A transparent overlay still eats clicks, so pointer events are tied
            // to the same condition that decides whether this paints at all. The
            // render guard above is the fix; this makes the lockout impossible
            // even if that guard ever regresses.
            pointerEvents: fading ? 'none' : 'auto',
            transition: `opacity ${fading ? num(settings.fadeOutMs, 360, 0, 10000) : num(settings.fadeInMs, 320, 0, 10000)}ms ease`,
          },
        },
        h('video', {
          ref: videoRef,
          playsInline: true,
          preload: 'auto',
          // `muted` is NOT a React prop here on purpose: the effect decides it
          // before calling play(), and a prop would race that decision.
          onEnded: finish,
          style: {
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: objectFit(settings.fit),
            background: typeof settings.background === 'string' ? settings.background : '#000000',
          },
          onClick: (event) => event.stopPropagation(),
        }),
        phase === 'playing'
          ? null
          : h('div', {
              style: {
                position: 'absolute',
                left: '50%',
                top: '50%',
                transform: 'translate(-50%, -50%)',
                padding: '10px 18px',
                borderRadius: '12px',
                background: 'rgba(0,0,0,.55)',
                color: '#fff',
                font: '13px/1.6 system-ui, sans-serif',
              },
            }, statusText),
        // The sound chip. Shown only when the platform refused audible playback,
        // which is exactly when a gesture is worth asking for.
        audio === 'blocked'
          ? h('button', {
              type: 'button',
              onClick: (event) => {
                event.stopPropagation()
                unlock()
              },
              style: {
                position: 'absolute',
                right: '18px',
                bottom: '64px',
                padding: '8px 16px',
                border: '1px solid rgba(255,255,255,.35)',
                borderRadius: '999px',
                background: 'rgba(20,44,70,.72)',
                color: '#fff',
                font: '13px/1.5 system-ui, sans-serif',
                cursor: 'pointer',
              },
            }, t.chip)
          : null,
        audio === 'on' && phase === 'playing'
          ? h('div', {
              style: {
                position: 'absolute',
                right: '18px',
                bottom: '64px',
                padding: '6px 14px',
                borderRadius: '999px',
                background: 'rgba(0,0,0,.45)',
                color: 'rgba(255,255,255,.85)',
                font: '12px/1.5 system-ui, sans-serif',
                pointerEvents: 'none',
              },
            }, t.chipOn)
          : null,
        settings.showFullscreenButton === true
          ? h('button', {
              type: 'button',
              onClick: (event) => {
                event.stopPropagation()
                askFullscreen()
              },
              style: {
                position: 'absolute',
                right: '18px',
                bottom: '18px',
                padding: '8px 16px',
                border: '1px solid rgba(255,255,255,.35)',
                borderRadius: '999px',
                background: 'rgba(20,44,70,.72)',
                color: '#fff',
                font: '13px/1.5 system-ui, sans-serif',
                cursor: 'pointer',
              },
            }, t.fullscreen)
          : null,
        settings.skip === 'button' || settings.skip === 'click'
          ? h('button', {
              type: 'button',
              onClick: (event) => {
                event.stopPropagation()
                close()
              },
              style: {
                position: 'absolute',
                right: '18px',
                bottom: settings.showFullscreenButton === true ? '64px' : '18px',
                padding: '8px 16px',
                border: '1px solid rgba(255,255,255,.35)',
                borderRadius: '999px',
                background: 'rgba(0,0,0,.45)',
                color: '#fff',
                font: '13px/1.5 system-ui, sans-serif',
                cursor: 'pointer',
              },
            }, `${t.skip}${remaining === null ? '' : ` · ${remaining}`}`)
          : null,
        h('div', {
          style: {
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            height: '3px',
            background: 'rgba(255,255,255,.18)',
          },
        }, h('div', {
          style: {
            width: `${Math.round(progress * 100)}%`,
            height: '100%',
            background: '#fff',
            transition: 'width .2s linear',
          },
        })),
      ))
    }

    /** The settings page: the sound switch, the volume, and the clip to play. */
    function BootAnimationSettings() {
      const t = strings()
      const [state, setState] = React.useState({ status: 'loading' })
      const [draft, setDraft] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      const apply = React.useCallback((result) => {
        const settings = (result && result.settings) || {}
        const shown = typeof result?.effectiveSrc === 'string' && result.effectiveSrc !== ''
          ? result.effectiveSrc
          : (typeof settings.src === 'string' ? settings.src : '')
        setDraft(shown)
        setState({
          status: 'ready',
          settings,
          media: (result && result.media) || { kind: 'none' },
          problem: (result && result.problem) || null,
          source: (result && result.source) || null,
          lastBoot: (result && result.lastBoot) || null,
          playState: (result && result.playState) || { plays: 0, lastPlayedOn: null },
          notice: null,
        })
      }, [])

      React.useEffect(() => {
        let cancelled = false
        loadConfig().then((result) => {
          if (!cancelled) apply(result)
        })
        return () => {
          cancelled = true
        }
      }, [apply])

      const save = async (patch) => {
        setBusy(true)
        const result = await post(SAVE_URL, patch)
        setBusy(false)
        if (result.ok !== true) {
          setState((previous) => ({ ...previous, status: 'ready', problem: result.error ?? 'write-failed' }))
          return
        }
        apply(result)
        setState((previous) => ({ ...previous, notice: t.saved }))
      }

      const choose = async () => {
        setBusy(true)
        const result = await post(PICK_URL)
        setBusy(false)
        if (result.ok !== true) {
          setState((previous) => ({ ...previous, status: 'ready', problem: result.error === 'picker-unavailable' ? 'picker-unavailable' : 'load-failed' }))
          return
        }
        if (typeof result.path === 'string' && result.path.trim() !== '') setDraft(result.path)
      }

      const settings = state.settings || {}
      const media = state.media || { kind: 'none' }
      const playing = state.status === 'ready' && media.kind === 'video' && settings.enabled === true
      const playState = state.playState || { plays: 0, lastPlayedOn: null }
      const resetCount = async () => {
        setBusy(true)
        const result = await post(RESET_URL)
        setBusy(false)
        if (result.ok !== true) {
          setState((previous) => ({ ...previous, status: 'ready', problem: result.error ?? 'write-failed' }))
          return
        }
        apply(result)
        setState((previous) => ({ ...previous, notice: t.resetDone }))
      }
      const problemText = state.problem === null || state.problem === undefined
        ? null
        : t.probs[state.problem] ?? String(state.problem)

      const FIELD = {
        boxSizing: 'border-box',
        width: '100%',
        minWidth: 0,
        height: '34px',
        padding: '0 12px',
        border: '0.5px solid var(--dsw-alias-border-l4, #d4d4d4)',
        borderRadius: '8px',
        background: 'var(--dsw-alias-bg-layer-3, #ffffff)',
        color: 'var(--dsw-alias-label-primary, #17181a)',
        font: 'inherit',
        fontSize: '13px',
      }
      const MUTED = { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #5c6068)', marginTop: '2px' }
      const ROW = { display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '14px' }

      const button = (label, onClick, options = {}) => h('button', {
        key: options.key ?? label,
        type: 'button',
        onClick,
        disabled: busy || options.disabled === true,
        style: {
          appearance: 'none',
          font: 'inherit',
          fontSize: '13px',
          lineHeight: 1.5,
          borderRadius: '8px',
          padding: '5px 14px',
          cursor: busy || options.disabled === true ? 'default' : 'pointer',
          opacity: busy || options.disabled === true ? 0.4 : 1,
          border: options.primary === true ? '1px solid transparent' : '1px solid var(--dsw-alias-border-l2, #d3d5da)',
          background: options.primary === true ? 'var(--dsw-alias-label-primary, #17181a)' : 'transparent',
          color: options.primary === true ? 'var(--dsw-alias-bg-layer-3, #ffffff)' : 'var(--dsw-alias-label-secondary, #5c6068)',
        },
      }, label)

      const toggle = (label, hint, checked, onCommit, key) => h('label', {
        key,
        style: { display: 'flex', gap: '10px', alignItems: 'flex-start', cursor: 'pointer' },
      }, [
        h('input', {
          key: 'box',
          type: 'checkbox',
          checked: checked === true,
          disabled: busy,
          onChange: (event) => onCommit(event.target.checked),
          style: { marginTop: '3px' },
        }),
        h('span', { key: 'text' }, [
          h('span', { key: 'label', style: { fontSize: '13px' } }, label),
          hint === null ? null : h('div', { key: 'hint', style: MUTED }, hint),
        ]),
      ])

      const lastBoot = state.lastBoot
      const lastBootLine = lastBoot === null || lastBoot === undefined
        ? t.noRecord
        : `${new Date(lastBoot.at).toLocaleString()} · ${(t.audioStates[lastBoot.audio] ?? lastBoot.audio ?? '')}`
          + ` · muted=${String(lastBoot.muted)} · fullscreen=${String(lastBoot.fullscreen)}`
          + ` · audioBytes=${String(lastBoot.audioDecodedBytes)}`

      return h('div', { style: { display: 'flex', flexDirection: 'column', maxWidth: '720px' } }, [
        h('div', { key: 'h', style: { fontSize: '14px', fontWeight: 600 } }, t.heading),
        h('p', { key: 'intro', style: { margin: '6px 0 0', fontSize: '13px', lineHeight: 1.7, color: 'var(--dsw-alias-label-secondary, #5c6068)' } }, t.intro),

        h('div', { key: 'sound', style: ROW }, [
          toggle(t.soundLabel, t.soundHint, settings.sound, (value) => save({ sound: value }), 'sound'),
        ]),
        h('div', { key: 'volume', style: ROW }, [
          h('span', { key: 'l', style: { fontSize: '13px' } }, `${t.volumeLabel} · ${Math.round(num(settings.volume, 0.9, 0, 1) * 100)}%`),
          h('input', {
            key: 'r',
            type: 'range',
            min: 0,
            max: 1,
            step: 0.05,
            value: num(settings.volume, 0.9, 0, 1),
            disabled: busy,
            onChange: (event) => {
              const next = Number(event.target.value)
              setState((previous) => ({ ...previous, settings: { ...(previous.settings || {}), volume: next } }))
            },
            onMouseUp: (event) => save({ volume: Number(event.target.value) }),
            onTouchEnd: (event) => save({ volume: Number(event.target.value) }),
          }),
        ]),
        h('div', { key: 'firstInput', style: ROW }, [
          toggle(t.firstInputLabel, t.firstInputHint, settings.soundOnFirstInput, (value) => save({ soundOnFirstInput: value }), 'first'),
        ]),
        h('div', { key: 'enabled', style: ROW }, [
          toggle(t.enabledLabel, null, settings.enabled, (value) => save({ enabled: value }), 'enabled'),
        ]),
        h('div', { key: 'fs', style: ROW }, [
          toggle(t.fsLabel, t.fsHint, settings.showFullscreenButton, (value) => save({ showFullscreenButton: value }), 'fs'),
        ]),
        h('div', { key: 'skip', style: ROW }, [
          h('span', { key: 'l', style: { fontSize: '13px' } }, t.skipLabel),
          h('select', {
            key: 's',
            value: settings.skip ?? 'button',
            disabled: busy,
            onChange: (event) => save({ skip: event.target.value }),
            style: { ...FIELD, appearance: 'auto' },
          }, [
            h('option', { key: 'b', value: 'button' }, t.skipButton),
            h('option', { key: 'c', value: 'click' }, t.skipClick),
            h('option', { key: 'a', value: 'auto' }, t.skipAuto),
            h('option', { key: 'n', value: 'never' }, t.skipNever),
          ]),
        ]),

        h('div', { key: 'trigger', style: ROW }, [
          h('span', { key: 'l', style: { fontSize: '13px' } }, t.triggerLabel),
          h('select', {
            key: 's',
            value: settings.trigger ?? 'pageRefresh',
            disabled: busy,
            onChange: (event) => save({ trigger: event.target.value }),
            style: { ...FIELD, appearance: 'auto' },
          }, [
            h('option', { key: 'a', value: 'appStart' }, t.triggers.appStart),
            h('option', { key: 'p', value: 'pageRefresh' }, t.triggers.pageRefresh),
            h('option', { key: 'n', value: 'newConversation' }, t.triggers.newConversation),
            h('option', { key: 'y', value: 'anySession' }, t.triggers.anySession),
          ]),
          h('div', { key: 'hint', style: MUTED }, t.triggerHint),
        ]),
        h('div', { key: 'frequency', style: ROW }, [
          h('span', { key: 'l', style: { fontSize: '13px' } }, t.frequencyLabel),
          h('select', {
            key: 's',
            value: settings.frequency ?? 'every',
            disabled: busy,
            onChange: (event) => save({ frequency: event.target.value }),
            style: { ...FIELD, appearance: 'auto' },
          }, [
            h('option', { key: 'e', value: 'every' }, t.frequencies.every),
            h('option', { key: 'd', value: 'daily' }, t.frequencies.daily),
            h('option', { key: 'o', value: 'once' }, t.frequencies.once),
            h('option', { key: 't', value: 'times' }, t.frequencies.times),
          ]),
          settings.frequency === 'times'
            ? h('div', { key: 'n', style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '4px' } }, [
                h('span', { key: 'l', style: { fontSize: '13px', whiteSpace: 'nowrap' } }, t.maxPlaysLabel),
                h('input', {
                  key: 'i',
                  type: 'number',
                  min: 1,
                  max: 1000,
                  step: 1,
                  // Saved on blur rather than on every keystroke: typing "12" would
                  // otherwise persist a budget of 1 on the way.
                  defaultValue: String(num(settings.maxPlays, 3, 1, 1000)),
                  disabled: busy,
                  onBlur: (event) => save({ maxPlays: Number(event.target.value) }),
                  style: { ...FIELD, width: '110px' },
                }),
              ])
            : null,
          h('div', { key: 'hint', style: MUTED }, t.frequencyHint),
        ]),

        h('div', { key: 'path', style: ROW }, [
          h('span', { key: 'l', style: { fontSize: '13px' } }, t.pathLabel),
          h('div', { key: 'row', style: { display: 'flex', gap: '8px' } }, [
            h('input', {
              key: 'i',
              type: 'text',
              value: draft,
              spellCheck: false,
              disabled: busy,
              placeholder: 'D:\\videos\\boot.mp4',
              onChange: (event) => setDraft(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') void save({ src: draft })
              },
              style: FIELD,
            }),
            button(t.choose, () => void choose(), { key: 'choose' }),
          ]),
          h('div', { key: 'hint', style: MUTED }, t.tabHint),
        ]),
        h('div', { key: 'actions', style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '12px' } }, [
          button(t.save, () => void save({ src: draft }), { key: 'save', primary: true }),
          button(t.clear, () => void save({ src: '' }), { key: 'clear', disabled: draft === '' }),
        ]),

        state.status === 'picking' ? h('p', { key: 'picking', style: MUTED }, t.picking) : null,
        state.notice ? h('p', { key: 'notice', role: 'status', style: { margin: '12px 0 0', fontSize: '13px', color: 'var(--dsw-alias-state-success-primary, #22c55e)' } }, state.notice) : null,
        problemText === null ? null : h('p', { key: 'problem', role: 'alert', style: { margin: '12px 0 0', fontSize: '13px', color: 'var(--dsw-alias-state-error-primary, #e5484d)' } }, problemText),

        h('div', {
          key: 'summary',
          style: {
            marginTop: '16px',
            padding: '12px 14px',
            border: '0.5px solid var(--dsw-alias-border-l4, #d4d4d4)',
            borderRadius: '12px',
            background: 'var(--dsw-alias-bg-layer-2, #f1f2f4)',
            fontSize: '13px',
            lineHeight: 1.7,
            color: 'var(--dsw-alias-label-secondary, #5c6068)',
          },
        }, [
          h('div', { key: 'title', style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary, #17181a)', marginBottom: '4px' } },
            `${t.current}: ${playing ? (state.source === 'bundled' ? t.bundled : t.willPlay) : t.none}`),
          playing ? h('div', { key: 'file', style: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px', wordBreak: 'break-all' } },
            `${media.name ?? ''}${media.bytes === undefined ? '' : `  ·  ${(media.bytes / 1024 / 1024).toFixed(2)} MB`}`) : null,
          // The ledger, and the way back out of a spent budget: `once` and `times`
          // are one-way doors otherwise, reopenable only by editing a file.
          h('div', { key: 'ledger', style: { marginTop: '8px', display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } }, [
            h('span', { key: 'text' },
              `${t.ledgerLabel}: ${playState.plays > 0 ? `${playState.plays} 次` : t.ledgerNever}`
              + `${playState.lastPlayedOn === null ? '' : `  ·  ${playState.lastPlayedOn}`}`),
            button(t.resetLedger, () => void resetCount(), { key: 'reset', disabled: playState.plays === 0 }),
          ]),
          h('div', { key: 'last', style: { marginTop: '8px' } }, `${t.lastBoot}: ${lastBootLine}`),
        ]),
      ])
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // The settings page is registered unconditionally: it is how a clip gets
        // chosen, and how the sound switch is reached.
        ctx.slots.inject(TAB_SLOT, () => ctx.slots.register(
          { name: TAB_SLOT, id: ROW_ID, order: 52, label: () => strings().tab },
          BootAnimationSettings,
        ))

        // ONE frame-wide component decides for itself whether to draw anything.
        //
        // The decision is made from an asynchronous settings read rather than a
        // synchronous payload, and that is safe because the Host injects the
        // first-paint cover: `#root` stays hidden from the HTML until this
        // component either mounts the animation (which calls `releaseCover()`)
        // or concludes there is nothing to play (which releases it immediately).
        // Nothing can flash the interface for a frame.
        ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register(
          { name: OVERLAY_SLOT, id: ROW_ID, order: 950 },
          BootAnimation,
        ))

        // The conversation triggers need a watcher, and only those triggers do:
        // wrapping a service the interface navigates with is not something to do
        // "just in case". The configuration is read once here; a failed read simply
        // means no watcher, which is the same as a trigger that never fires.
        loadConfig().then((loaded) => {
          const trigger = loaded && loaded.settings ? loaded.settings.trigger : null
          if (!CONVERSATION_TRIGGERS.has(trigger)) return
          const report = (occasion) => {
            claim(occasion).then((answer) => {
              if (answer !== null && answer.play === true) playStore.request()
            })
          }
          try {
            // `ctx.effect(callback)` runs the callback now and disposes whatever it
            // returns when the plugin goes away, which is exactly the lifetime the
            // wrappers want.
            if (typeof ctx.effect === 'function') ctx.effect(() => watchConversations(ctx, report))
            else watchConversations(ctx, report)
          } catch { /* an unwatched trigger beats a broken plugin */ }
        })

        // Leave a handle for diagnosis, and for the Host's watchdog to reach.
        try {
          globalThis.__DSH_BOOT_ANIMATION_SOUND__ = {
            version: 2,
            releaseCover,
            claim,
            playStore,
            config: CONFIG_URL,
          }
        } catch { /* a frozen globalThis is not worth failing a boot over */ }
      },
    }
  },
})
