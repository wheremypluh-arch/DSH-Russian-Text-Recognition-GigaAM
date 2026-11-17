// dsh-voice-ru — client half: dictation hotkeys and hands-free voice activation
// on top of the DSH speech Remote.
//
// Commands (all rebindable in Settings → Keyboard shortcuts):
//   voice.dictateHold   — push-to-talk: hold the keys, speak, release → text is sent
//   voice.dictateToggle — press once to start, press again → text is sent
//   voice.listen        — always-on listener: say the wake phrase, then dictate
//
// The bundle is a classic script for the DSH module loader: it registers a factory
// under the package name, and the factory returns the cordis plugin face.
window.__ModuleLoader__.load({
  id: 'dsh-voice-ru',
  factory: () => {
    const module = { exports: {} }
    const exports = module.exports

    const LOG = '[voice-ru]'
    const EMPTY_AUDIO_BYTES = 3200
    const SEGMENT_LIMIT_SECONDS = 12

    const messageOf = (error) => (error instanceof Error ? error.message : String(error))
    const warn = (text) => console.warn(`${LOG} ${text}`)
    const info = (text) => console.info(`${LOG} ${text}`)

    /**
     * Comparison form: lower case, ё→е, no punctuation, repeated letters collapsed
     * ("Гигаам!" → "гигам"), single spaces. Used for wake/stop phrases only.
     */
    function canonicalize(text) {
      return String(text)
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[^a-zа-я0-9\s]/g, ' ')
        .replace(/([a-zа-я0-9])\1+/g, '$1')
        .replace(/\s+/g, ' ')
        .trim()
    }

    /** Space-free comparison form: "эй, гигам" и "эйгигам" дают одно и то же. */
    function compact(text) {
      return canonicalize(text).replace(/\s+/g, '')
    }

    /** Levenshtein distance with a cheap length bail-out. */
    function distance(left, right) {
      if (left === right) return 0
      if (Math.abs(left.length - right.length) > 2) return 99
      let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
      for (let i = 1; i <= left.length; i += 1) {
        const current = [i]
        for (let j = 1; j <= right.length; j += 1) {
          current[j] = Math.min(
            previous[j] + 1,
            current[j - 1] + 1,
            previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
          )
        }
        previous = current
      }
      return previous[right.length]
    }

    /** «эй гига» → «Эй Гига»: подсказка в интерфейсе, без хвостовой пунктуации. */
    function displayPhrase(value) {
      const raw = Array.isArray(value) && typeof value[0] === 'string' ? value[0].trim() : ''
      const source = raw === '' ? 'эй гига' : raw
      return source
        .replace(/(^|\s)([a-zа-яё])/g, (_, space, letter) => space + letter.toUpperCase())
        .replace(/[!?.]+$/, '')
    }

    /** Canonical phrase list from config, deduplicated. */
    function phrases(value, fallback) {
      const source = Array.isArray(value) && value.length > 0 ? value : fallback
      const out = []
      for (const entry of source) {
        const canonical = canonicalize(entry)
        if (canonical !== '' && !out.includes(canonical)) out.push(canonical)
      }
      return out
    }

    function settings(config) {
      return {
        wake: phrases(config?.wakePhrases, ['эй гига']),
        wakeDisplay: displayPhrase(config?.wakePhrases),
        send: phrases(config?.sendPhrases, ['отправь', 'отправить', 'готово']),
        cancel: phrases(config?.cancelPhrases, ['стоп', 'отмена', 'отмени']),
        sendDelayMs: Number.isFinite(config?.sendDelayMs) && config.sendDelayMs >= 0 ? config.sendDelayMs : 5000,
        beep: config?.beep !== false,
        debug: config?.debug === true,
        delivery: config?.delivery === 'send' ? 'send' : 'draft',
        wakeTolerance:
          Number.isInteger(config?.wakeTolerance) && config.wakeTolerance >= 0 && config.wakeTolerance <= 3
            ? config.wakeTolerance
            : 1,
        fillers: phrases(config?.fillerWords, ['ну', 'так', 'а', 'и', 'вот', 'окей', 'ок']),
      }
    }

    /** Canonical 16 kHz mono PCM16 WAV, the only format the Host provider accepts. */
    function encodeWave(samples) {
      const bytes = new Uint8Array(44 + samples.length * 2)
      const view = new DataView(bytes.buffer)
      const text = (at, value) => {
        for (let i = 0; i < value.length; i += 1) bytes[at + i] = value.charCodeAt(i)
      }
      text(0, 'RIFF')
      view.setUint32(4, bytes.length - 8, true)
      text(8, 'WAVE')
      text(12, 'fmt ')
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true)
      view.setUint16(22, 1, true)
      view.setUint32(24, 16000, true)
      view.setUint32(28, 32000, true)
      view.setUint16(32, 2, true)
      view.setUint16(34, 16, true)
      text(36, 'data')
      view.setUint32(40, samples.length * 2, true)
      for (let index = 0; index < samples.length; index += 1) {
        const sample = Math.max(-1, Math.min(1, samples[index]))
        view.setInt16(44 + index * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true)
      }
      return bytes
    }

    /** Base64 without a data-URL prefix, as the speech Remote expects. */
    function audioBase64(bytes) {
      let text = ''
      for (let index = 0; index < bytes.length; index += 8192)
        text += String.fromCharCode.apply(null, bytes.subarray(index, index + 8192))
      return btoa(text)
    }

    function concat(chunks, length) {
      const merged = new Float32Array(length)
      let offset = 0
      for (const chunk of chunks) {
        merged.set(chunk, offset)
        offset += chunk.length
      }
      return merged
    }

    /**
     * Small floating lamp reporting the dictation state: listening for the wake
     * phrase, dictating, recording or transcribing. Plain DOM on purpose — the
     * hand-written bundle needs no React; without a document (unit tests) every
     * call is a no-op.
     */
    class Indicator {
      constructor(hint) {
        this.hint = hint ?? 'Эй Гига'
        this.root = undefined
        this.dot = undefined
        this.text = undefined
        this.state = null
      }

      ensure() {
        if (this.root !== undefined) return true
        if (typeof document === 'undefined' || document.body == null) return false
        const existing = document.getElementById('dsh-voice-ru-indicator')
        if (existing !== null) {
          this.root = existing
          this.dot = existing.firstElementChild
          this.text = existing.lastElementChild
          return true
        }
        const style = document.createElement('style')
        style.textContent = [
          '#dsh-voice-ru-indicator{position:fixed;right:16px;bottom:16px;z-index:2147483000;display:none;',
          'align-items:center;gap:8px;padding:6px 12px;border-radius:999px;background:rgba(20,20,24,.86);',
          'color:#fff;font:12px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.35);',
          'pointer-events:none;user-select:none}',
          '#dsh-voice-ru-indicator[data-visible="true"]{display:flex}',
          '#dsh-voice-ru-indicator .dsh-voice-ru-dot{width:8px;height:8px;border-radius:50%;background:#3ddc84;',
          'animation:dsh-voice-ru-pulse 1.2s ease-in-out infinite}',
          '@keyframes dsh-voice-ru-pulse{0%,100%{opacity:1}50%{opacity:.3}}',
        ].join('')
        document.head.appendChild(style)
        const root = document.createElement('div')
        root.id = 'dsh-voice-ru-indicator'
        root.setAttribute('role', 'status')
        root.setAttribute('aria-live', 'polite')
        const dot = document.createElement('span')
        dot.className = 'dsh-voice-ru-dot'
        const text = document.createElement('span')
        root.appendChild(dot)
        root.appendChild(text)
        document.body.appendChild(root)
        this.root = root
        this.dot = dot
        this.text = text
        return true
      }

      set(state) {
        if (state === null || state === undefined) {
          if (this.root !== undefined) this.root.dataset.visible = 'false'
          this.state = null
          return
        }
        if (!this.ensure()) return
        const colors = { listening: '#3ddc84', dictating: '#6aa8ff', recording: '#ff5c5c', transcribing: '#ffcc4d' }
        const labels = {
          listening: `Скажите: «${this.hint}!»`,
          dictating: 'диктовка',
          recording: 'запись',
          transcribing: 'распознаю',
        }
        this.root.dataset.visible = 'true'
        this.dot.style.background = colors[state] ?? '#3ddc84'
        this.text.textContent = labels[state] ?? state
        this.state = state
      }

      dispose() {
        if (this.root !== undefined && this.root.parentNode !== null) this.root.parentNode.removeChild(this.root)
        this.root = undefined
        this.dot = undefined
        this.text = undefined
        this.state = null
      }
    }

    /** Resample native-rate mono samples to the canonical 16 kHz WAV. */
    async function toWave(samples, rate) {
      if (rate === 16000) return encodeWave(samples)
      const frames = Math.max(1, Math.floor((samples.length * 16000) / rate))
      const offline = new OfflineAudioContext(1, frames, 16000)
      const buffer = offline.createBuffer(1, samples.length, rate)
      if (typeof buffer.copyToChannel === 'function') buffer.copyToChannel(samples, 0)
      else buffer.getChannelData(0).set(samples)
      const source = offline.createBufferSource()
      source.buffer = buffer
      source.connect(offline.destination)
      source.start()
      const rendered = await offline.startRendering()
      return encodeWave(rendered.getChannelData(0))
    }

    /** One microphone acquisition: raw capture in, canonical WAV out. */
    class Capture {
      constructor() {
        this.stream = undefined
        this.recorder = undefined
        this.context = undefined
        this.chunks = []
      }

      async start() {
        if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia)
          throw new Error('браузер не даёт доступ к микрофону')
        if (typeof MediaRecorder === 'undefined') throw new Error('MediaRecorder недоступен')
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
          video: false,
        })
        this.stream = stream
        this.context = new AudioContext()
        this.chunks = []
        const recorder = new MediaRecorder(stream)
        this.recorder = recorder
        recorder.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) this.chunks.push(event.data)
        }
        recorder.start()
      }

      async stop(maxSeconds) {
        const recorder = this.recorder
        const context = this.context
        if (!recorder || recorder.state !== 'recording' || !context) throw new Error('запись не начата')
        try {
          await new Promise((resolve, reject) => {
            recorder.onstop = () => resolve()
            recorder.onerror = () => reject(new Error('запись прервана'))
            recorder.stop()
          })
          const blob = new Blob(this.chunks, { type: recorder.mimeType || 'audio/webm' })
          if (blob.size === 0) throw new Error('пустая запись')
          const decoded = await context.decodeAudioData(await blob.arrayBuffer())
          const seconds = Math.max(0, Math.min(decoded.duration, maxSeconds))
          const frames = Math.max(1, Math.floor(seconds * 16000))
          const offline = new OfflineAudioContext(1, frames, 16000)
          const source = offline.createBufferSource()
          source.buffer = decoded
          source.connect(offline.destination)
          source.start()
          const rendered = await offline.startRendering()
          return encodeWave(rendered.getChannelData(0))
        } finally {
          await this.dispose()
        }
      }

      async dispose() {
        const recorder = this.recorder
        if (recorder && recorder.state === 'recording') {
          try {
            recorder.stop()
          } catch {}
        }
        if (this.stream) for (const track of this.stream.getTracks()) track.stop()
        this.stream = undefined
        this.recorder = undefined
        this.chunks = []
        const context = this.context
        this.context = undefined
        if (context && context.state !== 'closed' && typeof context.close === 'function') {
          try {
            await context.close()
          } catch {}
        }
      }
    }

    /**
     * Always-on microphone with an energy VAD: every completed speech segment is
     * handed over as a canonical WAV, so the wake phrase can be recognized by the
     * same local model as dictation (there is no streaming ASR in this stack).
     */
    class Listener {
      constructor(handlers, beep) {
        this.handlers = handlers
        this.beep = beep
        this.stream = undefined
        this.context = undefined
        this.source = undefined
        this.processor = undefined
        this.gain = undefined
        this.rate = 16000
        this.chunks = []
        this.length = 0
        this.silence = 0
        this.capturing = false
        this.floor = 0.004
      }

      async start() {
        if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia)
          throw new Error('браузер не даёт доступ к микрофону')
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
          video: false,
        })
        this.stream = stream
        let context
        try {
          context = new AudioContext({ sampleRate: 16000 })
        } catch {
          context = new AudioContext()
        }
        this.context = context
        this.rate = context.sampleRate || 16000
        this.source = context.createMediaStreamSource(stream)
        this.processor = context.createScriptProcessor(2048, 1, 1)
        this.processor.onaudioprocess = (event) => this.push(event.inputBuffer.getChannelData(0))
        // A zero-gain sink keeps the graph pulled without echoing the microphone.
        this.gain = context.createGain()
        this.gain.gain.value = 0
        this.source.connect(this.processor)
        this.processor.connect(this.gain)
        this.gain.connect(context.destination)
      }

      threshold() {
        return Math.min(0.03, Math.max(0.008, this.floor * 2.5))
      }

      push(chunk) {
        let sum = 0
        for (let index = 0; index < chunk.length; index += 1) sum += chunk[index] * chunk[index]
        const rms = Math.sqrt(sum / Math.max(1, chunk.length))
        const speaking = rms >= this.threshold()
        if (!speaking && !this.capturing) this.floor = this.floor * 0.95 + rms * 0.05
        if (speaking) {
          if (!this.capturing) {
            this.capturing = true
            this.length = 0
            this.chunks = []
            this.handlers.onSpeechStart?.()
          }
          this.silence = 0
          this.handlers.onActivity?.()
        } else if (this.capturing) {
          this.silence += chunk.length / this.rate
        } else {
          return
        }
        this.chunks.push(Float32Array.from(chunk))
        this.length += chunk.length
        if (this.silence >= 0.5 || this.length / this.rate >= SEGMENT_LIMIT_SECONDS) this.finish()
      }

      /** Close the current segment now, without waiting for the silence threshold. */
      flush() {
        if (!this.capturing) return Promise.resolve()
        return this.finish()
      }

      finish() {
        const chunks = this.chunks
        const length = this.length
        const rate = this.rate
        this.chunks = []
        this.length = 0
        this.silence = 0
        this.capturing = false
        if (length / rate < 0.4) return Promise.resolve()
        return (async () => {
          try {
            this.handlers.onSegment?.(await toWave(concat(chunks, length), rate))
          } catch (error) {
            warn(`сегмент не собран: ${messageOf(error)}`)
          }
        })()
      }

      /** Short confirmation tone; failures are irrelevant to dictation. */
      async tone(frequency) {
        if (!this.beep || !this.context) return
        try {
          const oscillator = this.context.createOscillator()
          const gain = this.context.createGain()
          gain.gain.value = 0.04
          oscillator.frequency.value = frequency
          oscillator.connect(gain)
          gain.connect(this.context.destination)
          oscillator.start()
          oscillator.stop(this.context.currentTime + 0.08)
        } catch {}
      }

      async dispose() {
        try {
          if (this.processor) {
            this.processor.onaudioprocess = null
            this.processor.disconnect()
          }
          this.source?.disconnect()
          this.gain?.disconnect()
        } catch {}
        this.processor = undefined
        this.source = undefined
        this.gain = undefined
        if (this.stream) for (const track of this.stream.getTracks()) track.stop()
        this.stream = undefined
        const context = this.context
        this.context = undefined
        if (context && context.state !== 'closed' && typeof context.close === 'function') {
          try {
            await context.close()
          } catch {}
        }
      }
    }

    /** Hold/toggle/listen state machine: one capture at a time, text goes to the chat. */
    class Hotkeys {
      constructor(ctx, config) {
        this.ctx = ctx
        this.config = settings(config)
        this.phase = 'idle'
        this.mode = undefined
        this.capture = undefined
        this.abort = undefined
        this.timer = undefined
        this.holdCode = undefined
        this.releasePending = false
        this.lastCode = undefined
        this.selection = {}
        this.limits = { maxAudioBytes: 20 * 1024 * 1024, maxDurationSeconds: 600 }
        this.listener = undefined
        this.draft = ''
        this.sendTimer = undefined
        this.segments = Promise.resolve()
        this.indicator = new Indicator(this.config.wakeDisplay)
        this.wakeCompact = this.config.wake.map((phrase) => phrase.replace(/\s+/g, ''))
        this.flushing = false
      }

      holdCommand() {
        return {
          id: 'voice.dictateHold',
          label: () => 'Диктовка: удерживать клавишу',
          aliases: ['push to talk', 'voice hold', 'диктовка удержанием'],
          defaults: {
            'desktop:windows': { code: 'F9', modifiers: [] },
            'desktop:macos': { code: 'F9', modifiers: [] },
            'web:windows': { code: 'KeyV', modifiers: ['primary', 'shift'] },
            'web:macos': { code: 'KeyV', modifiers: ['primary', 'shift'] },
          },
          regions: ['page', 'editable'],
          modals: [],
          resolve: () => this.resolveHold(),
        }
      }

      toggleCommand() {
        return {
          id: 'voice.dictateToggle',
          label: () => 'Диктовка: нажать и нажать ещё раз для отправки',
          aliases: ['toggle dictation', 'voice toggle', 'диктовка переключателем'],
          defaults: {
            'desktop:windows': { code: 'F10', modifiers: [] },
            'desktop:macos': { code: 'F10', modifiers: [] },
            'web:windows': { code: 'Period', modifiers: ['primary', 'shift'] },
            'web:macos': { code: 'Period', modifiers: ['primary', 'shift'] },
          },
          regions: ['page', 'editable'],
          modals: [],
          resolve: () => this.resolveToggle(),
        }
      }

      listenCommand() {
        return {
          id: 'voice.listen',
          label: () => 'Голосовая активация: слушать фразу',
          aliases: ['voice wake', 'always listening', 'голосовая активация'],
          defaults: {
            'desktop:windows': { code: 'F8', modifiers: [] },
            'desktop:macos': { code: 'F8', modifiers: [] },
            'web:windows': { code: 'KeyL', modifiers: ['primary', 'shift'] },
            'web:macos': { code: 'KeyL', modifiers: ['primary', 'shift'] },
          },
          regions: ['page', 'editable'],
          modals: [],
          resolve: () => this.resolveListen(),
        }
      }

      busyReason() {
        return this.phase === 'transcribing' ? 'Идёт распознавание' : 'Диктовка уже начата'
      }

      resolveHold() {
        if (this.phase === 'listening') return { status: 'handled', run: () => void this.holdFromListening() }
        if (this.phase === 'idle') {
          this.holdCode = this.lastCode
          return { status: 'handled', run: () => void this.start('hold') }
        }
        if (this.phase === 'recording' && this.mode === 'hold') return { status: 'handled', run: () => {} }
        return { status: 'blocked', reason: this.busyReason() }
      }

      resolveToggle() {
        if (this.phase === 'listening') return { status: 'handled', run: () => void this.toggleFromListening() }
        if (this.phase === 'idle') return { status: 'handled', run: () => void this.start('toggle') }
        if (this.phase === 'recording' && this.mode === 'toggle')
          return { status: 'handled', run: () => void this.stopAndSend() }
        return { status: 'blocked', reason: this.busyReason() }
      }

      resolveListen() {
        if (this.listener !== undefined) return { status: 'handled', run: () => void this.stopListening() }
        if (this.phase === 'idle') return { status: 'handled', run: () => void this.startListening() }
        return { status: 'blocked', reason: this.busyReason() }
      }

      async holdFromListening() {
        await this.stopListening()
        this.holdCode = this.lastCode
        await this.start('hold')
      }

      async toggleFromListening() {
        await this.stopListening()
        await this.start('toggle')
      }

      /** Raw keys: remember the held code, release-to-stop, Escape/blur cancel, never strand a recording. */
      installKeys() {
        const win = window
        const onKeyDown = (event) => {
          if (!event.repeat) this.lastCode = event.code
          if (event.code !== 'Escape') return
          if (this.listener !== undefined) {
            event.preventDefault()
            event.stopPropagation()
            void this.stopListening()
            return
          }
          if (this.phase === 'recording' || this.phase === 'requesting') {
            event.preventDefault()
            event.stopPropagation()
            void this.cancel('диктовка отменена')
          }
        }
        const onKeyUp = (event) => this.release(event)
        const onBlur = () => {
          if (this.phase === 'recording' || this.phase === 'requesting') void this.cancel('окно потеряло фокус')
        }
        win.addEventListener('keydown', onKeyDown, true)
        win.addEventListener('keyup', onKeyUp, true)
        win.addEventListener('blur', onBlur)
        return () => {
          win.removeEventListener('keydown', onKeyDown, true)
          win.removeEventListener('keyup', onKeyUp, true)
          win.removeEventListener('blur', onBlur)
        }
      }

      release(event) {
        if (this.phase === 'idle' || this.mode !== 'hold') return
        if (this.holdCode !== undefined && event.code !== this.holdCode) return
        if (this.phase === 'requesting') {
          this.releasePending = true
          return
        }
        if (this.phase === 'recording') void this.stopAndSend()
      }

      async start(mode) {
        if (this.phase !== 'idle') return
        if (this.listener !== undefined) await this.stopListening()
        this.phase = 'requesting'
        this.mode = mode
        this.releasePending = false
        const abort = (this.abort = new AbortController())
        const capture = (this.capture = new Capture())
        try {
          const catalog = await this.ctx.remote.speech.catalog()
          if (abort.signal.aborted) return
          if (!catalog.ok) throw catalog.error
          const value = catalog.value ?? {}
          this.limits = {
            maxAudioBytes: value.maxAudioBytes > 0 ? value.maxAudioBytes : this.limits.maxAudioBytes,
            maxDurationSeconds:
              value.maxDurationSeconds > 0 ? value.maxDurationSeconds : this.limits.maxDurationSeconds,
          }
          this.selection = value.selection ?? {}
          await capture.start()
          if (abort.signal.aborted) {
            await capture.dispose()
            return
          }
          this.phase = 'recording'
          this.indicator.set('recording')
          this.timer = setTimeout(() => void this.stopAndSend(), this.limits.maxDurationSeconds * 1000)
          if (this.releasePending) {
            this.releasePending = false
            void this.stopAndSend()
          }
        } catch (error) {
          if (abort.signal.aborted) return
          warn(`не удалось начать запись: ${messageOf(error)}`)
          await this.reset()
        }
      }

      async stopAndSend() {
        if (this.phase !== 'recording') return
        this.phase = 'transcribing'
        this.indicator.set('transcribing')
        const capture = this.capture
        const abort = this.abort
        try {
          const audio = await capture.stop(this.limits.maxDurationSeconds)
          if (audio.byteLength > this.limits.maxAudioBytes) throw new Error('запись длиннее лимита')
          if (audio.byteLength <= EMPTY_AUDIO_BYTES) throw new Error('слишком короткая запись')
          const result = await this.ctx.remote.speech.transcribe(
            { audioBase64: audioBase64(audio), ...this.selection },
            abort?.signal,
          )
          if (!result.ok) throw result.error
          const text = String(result.value?.text ?? '').trim()
          if (text === '') {
            warn('ничего не распознано — отправлять нечего')
            return
          }
          await this.deliver(text)
        } catch (error) {
          if (!abort?.signal.aborted) warn(`распознавание не удалось: ${messageOf(error)}`)
        } finally {
          await this.reset()
        }
      }

      async startListening() {
        if (this.phase !== 'idle') return
        this.phase = 'requesting'
        try {
          const catalog = await this.ctx.remote.speech.catalog()
          if (!catalog.ok) throw catalog.error
          const value = catalog.value ?? {}
          this.selection = value.selection ?? {}
          this.listener = new Listener(
            {
              onSpeechStart: () => this.touchIdle(),
              onActivity: () => this.touchIdle(),
              onSegment: (wav) => void this.enqueueSegment(wav),
            },
            this.config.beep,
          )
          await this.listener.start()
          this.phase = 'listening'
          this.draft = ''
          this.indicator.set('listening')
          info(`Скажите: «${this.config.wakeDisplay}!»`)
        } catch (error) {
          warn(`не удалось включить прослушивание: ${messageOf(error)}`)
          await this.stopListening()
        }
      }

      async stopListening() {
        this.clearSendTimer()
        this.flushing = false
        this.draft = ''
        this.indicator.set(null)
        const listener = this.listener
        this.listener = undefined
        if (this.phase === 'listening' || this.phase === 'dictating' || this.phase === 'requesting')
          this.phase = 'idle'
        if (listener) await listener.dispose()
      }

      /** Segments are transcribed one after another; the provider serialises them anyway. */
      enqueueSegment(wav) {
        this.segments = this.segments.then(() => this.handleSegment(wav)).catch((error) => {
          warn(`сегмент не распознан: ${messageOf(error)}`)
        })
        return this.segments
      }

      async handleSegment(wav) {
        if (this.listener === undefined) return
        const result = await this.ctx.remote.speech.transcribe(
          { audioBase64: audioBase64(wav), ...this.selection },
          undefined,
        )
        if (!result.ok) {
          warn(`распознавание не удалось: ${messageOf(result.error)}`)
          return
        }
        const text = String(result.value?.text ?? '').trim()
        if (text === '') return
        const canonical = canonicalize(text)
        if (canonical === '') return
        if (this.config.debug) info(`услышал ${JSON.stringify(text)} → «${canonical}» [${compact(text)}] (${this.phase})`)

        if (this.phase === 'listening') {
          if (this.config.send.includes(canonical)) {
            await this.submitComposer()
            return
          }
          const tail = this.matchWake(text)
          if (tail === null) return
          if (tail !== '') {
            await this.deliver(tail)
            return
          }
          this.phase = 'dictating'
          this.draft = ''
          this.indicator.set('dictating')
          this.touchIdle()
          await this.listener?.tone(880)
          info('диктовка включена')
          return
        }

        if (this.phase !== 'dictating') return
        if (this.config.cancel.includes(canonical)) {
          this.draft = ''
          this.phase = 'listening'
          this.indicator.set('listening')
          this.clearSendTimer()
          info('диктовка отменена')
          return
        }
        if (this.config.send.includes(canonical)) {
          await this.sendDraft(true)
          return
        }
        this.draft = this.draft === '' ? text : `${this.draft} ${text}`
        this.touchIdle()
      }

      /**
       * Text after the wake phrase, or null when the segment does not start with it.
       * Сравнение идёт по слитной форме с допуском на опечатки: «эй гигам»,
       * «эйгигам», «эй, гигам!» и вариант с одной ошибкой распознавания
       * включают диктовку одинаково.
       */
      matchWake(text) {
        const words = text.trim().split(/\s+/)
        let best
        for (let start = 0; start < Math.min(words.length, 3); start += 1) {
          if (start > 0 && !this.config.fillers.includes(canonicalize(words[start - 1]))) break
          for (let size = 1; size <= Math.min(words.length - start, 5); size += 1) {
            const candidate = compact(words.slice(start, start + size).join(' '))
            for (const phrase of this.wakeCompact) {
              const gap = distance(candidate, phrase)
              if (gap === 0) return words.slice(start + size).join(' ')
              if (gap <= this.config.wakeTolerance) best = Math.max(best ?? 0, start + size)
            }
          }
        }
        return best === undefined ? null : words.slice(best).join(' ')
      }

      /** Restart the silence countdown: any speech activity postpones the flush. */
      touchIdle() {
        if (this.phase !== 'dictating' || this.flushing) return
        this.clearSendTimer()
        this.sendTimer = setTimeout(() => void this.flushDictation(), this.config.sendDelayMs)
      }

      /**
       * Pause longer than sendDelayMs (3 s by default): close the current segment
       * without waiting for the VAD, drain the transcription queue and deliver the
       * accumulated text — dictation must not hang until a stop word.
       */
      async flushDictation() {
        if (this.phase !== 'dictating' || this.flushing) return
        this.flushing = true
        try {
          this.clearSendTimer()
          await this.listener?.flush()
          await this.segments
          await this.sendDraft()
        } catch (error) {
          warn(`не удалось завершить диктовку: ${messageOf(error)}`)
        } finally {
          this.flushing = false
        }
      }

      clearSendTimer() {
        if (this.sendTimer === undefined) return
        clearTimeout(this.sendTimer)
        this.sendTimer = undefined
      }

      async sendDraft(submit = false) {
        this.clearSendTimer()
        const draft = this.draft.trim()
        this.draft = ''
        this.phase = 'listening'
        this.indicator.set('listening')
        if (draft === '') return
        try {
          await this.deliver(draft)
          if (submit && this.config.delivery === 'draft') await this.submitComposer()
          await this.listener?.tone(660)
        } catch (error) {
          warn(`отправить не удалось: ${messageOf(error)}`)
        }
      }

      /**
       * Delivery policy: `draft` puts the recognized text into the composer and
       * leaves sending to the user; `send` submits it as a message immediately.
       * Draft insertion goes through the conversation.input shell, which owns the
       * editor revision, so concurrent typing cannot be overwritten.
       */
      async deliver(text) {
        if (this.config.delivery === 'send') return this.send(text)
        const shell = this.inputShell()
        if (shell === undefined) {
          warn('поле ввода недоступно — отправляю сообщением')
          return this.send(text)
        }
        const current = String(shell.projection?.clipboardText ?? '')
        const chunk = current.trim() === '' ? text : ` ${text}`
        const insert = shell.actions?.insertText
        const span = shell.actions?.captureInsertion?.()
        if (typeof insert === 'function' && span !== undefined) {
          try {
            if (insert.call(shell.actions, chunk, span)) {
              info('текст добавлен в поле ввода')
              return
            }
          } catch {}
        }
        shell.setDraft(`${current}${chunk}`)
        info('текст добавлен в поле ввода')
      }

      /** Submit whatever the composer holds: the voice word «отправить» must send. */
      async submitComposer() {
        const shell = this.inputShell()
        const submit = shell?.actions?.submit
        if (typeof submit === 'function') {
          submit.call(shell.actions)
          info('отправлено по голосовой команде')
          return
        }
        warn('поле ввода недоступно — отправлять нечем')
      }

      /** The composer shell of the visible session, when the input service is up. */
      inputShell() {
        const id = this.activeSession()
        if (id === undefined) return undefined
        const hub = this.ctx.get?.('conversation.input')
        if (hub === undefined || typeof hub.shell !== 'function') return undefined
        try {
          return hub.shell(id)
        } catch {
          return undefined
        }
      }

      async send(text) {
        const id = this.activeSession()
        if (id === undefined) throw new Error('нет активной сессии')
        const scope = this.ctx.sessions.scope(id)
        const conversation = scope?.get?.('conversation')
        if (!conversation || typeof conversation.send !== 'function')
          throw new Error('сервис conversation недоступен')
        await conversation.send(text)
      }

      /** The session the composer is showing; falls back to the first kept row. */
      activeSession() {
        const list = this.ctx.sessions.list.getSnapshot()
        const ids = Array.isArray(list.ids) ? list.ids : Object.keys(list.byId ?? {})
        const visible = ids.find((id) => (list.byId?.[id]?.retainedBy?.mainView ?? 0) > 0)
        return visible ?? ids[0]
      }

      async cancel(reason) {
        if (this.phase === 'idle') return
        warn(reason)
        try {
          this.abort?.abort(new Error('cancelled'))
        } catch {}
        await this.reset()
      }

      async reset() {
        if (this.timer !== undefined) {
          clearTimeout(this.timer)
          this.timer = undefined
        }
        const capture = this.capture
        this.capture = undefined
        this.abort = undefined
        if (this.phase !== 'listening' && this.phase !== 'dictating') this.phase = 'idle'
        if (this.phase === 'idle') this.indicator.set(null)
        this.mode = undefined
        this.releasePending = false
        if (capture) {
          try {
            await capture.dispose()
          } catch {}
        }
      }

      dispose() {
        void this.stopListening()
        void this.reset()
        this.indicator.dispose()
      }
    }

    function apply(ctx, config) {
      ctx.inject(['remote.speech'], (scope) => {
        const hotkeys = new Hotkeys(scope, config)
        scope.effect(() => () => hotkeys.dispose(), 'voice-hotkeys: lifecycle')
        scope.effect(() => scope.shortcuts.register(hotkeys.holdCommand()), 'voice-hotkeys: hold command')
        scope.effect(() => scope.shortcuts.register(hotkeys.toggleCommand()), 'voice-hotkeys: toggle command')
        scope.effect(() => scope.shortcuts.register(hotkeys.listenCommand()), 'voice-hotkeys: listen command')
        scope.effect(() => hotkeys.installKeys(), 'voice-hotkeys: raw keys')
        info('команды готовы: Ctrl+Shift+V диктовка, Ctrl+Shift+. переключатель, Ctrl+Shift+L прослушивание')
      })
    }

    exports.name = 'dsh-voice-ru'
    exports.inject = ['remote', 'shortcuts', 'sessions']
    exports.apply = apply
    return module.exports
  },
})
