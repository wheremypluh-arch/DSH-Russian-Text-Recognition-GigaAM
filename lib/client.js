// dsh-voice-ru — client half: dictation hotkeys on top of the DSH speech Remote.
//
// Two rebindable commands share one capture pipeline:
//   voice.dictateHold   — push-to-talk: hold the keys, speak, release → text is sent
//   voice.dictateToggle — press once to start, press again → text is sent
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

    const messageOf = (error) => (error instanceof Error ? error.message : String(error))
    const warn = (text) => console.warn(`${LOG} ${text}`)

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

    /** Hold/toggle state machine: one recording at a time, text goes straight to the chat. */
    class Hotkeys {
      constructor(ctx) {
        this.ctx = ctx
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
      }

      holdCommand() {
        return {
          id: 'voice.dictateHold',
          label: () => 'Диктовка: удерживать клавишу',
          aliases: ['push to talk', 'voice hold', 'диктовка удержанием'],
          defaults: {
            'desktop:windows': { code: 'F9', modifiers: [] },
            'desktop:macos': { code: 'F9', modifiers: [] },
            'web:windows': { code: 'KeyM', modifiers: ['primary', 'shift'] },
            'web:macos': { code: 'KeyM', modifiers: ['primary', 'shift'] },
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

      busyReason() {
        return this.phase === 'transcribing' ? 'Идёт распознавание' : 'Диктовка уже начата'
      }

      resolveHold() {
        if (this.phase === 'idle') {
          this.holdCode = this.lastCode
          return { status: 'handled', run: () => void this.start('hold') }
        }
        if (this.phase === 'recording' && this.mode === 'hold') return { status: 'handled', run: () => {} }
        return { status: 'blocked', reason: this.busyReason() }
      }

      resolveToggle() {
        if (this.phase === 'idle') return { status: 'handled', run: () => void this.start('toggle') }
        if (this.phase === 'recording' && this.mode === 'toggle')
          return { status: 'handled', run: () => void this.stopAndSend() }
        return { status: 'blocked', reason: this.busyReason() }
      }

      /** Raw keys: remember the held code, release-to-stop, Escape/blur cancel, never strand a recording. */
      installKeys() {
        const win = window
        const onKeyDown = (event) => {
          if (!event.repeat) this.lastCode = event.code
          if (event.code === 'Escape' && (this.phase === 'recording' || this.phase === 'requesting')) {
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
          await this.send(text)
        } catch (error) {
          if (!abort?.signal.aborted) warn(`распознавание не удалось: ${messageOf(error)}`)
        } finally {
          await this.reset()
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
        this.phase = 'idle'
        this.mode = undefined
        this.releasePending = false
        if (capture) {
          try {
            await capture.dispose()
          } catch {}
        }
      }

      dispose() {
        void this.reset()
      }
    }

    function apply(ctx) {
      ctx.inject(['remote.speech'], (scope) => {
        const hotkeys = new Hotkeys(scope)
        scope.effect(() => () => hotkeys.dispose(), 'voice-hotkeys: lifecycle')
        scope.effect(() => scope.shortcuts.register(hotkeys.holdCommand()), 'voice-hotkeys: hold command')
        scope.effect(() => scope.shortcuts.register(hotkeys.toggleCommand()), 'voice-hotkeys: toggle command')
        scope.effect(() => hotkeys.installKeys(), 'voice-hotkeys: raw keys')
      })
    }

    exports.name = 'dsh-voice-ru'
    exports.inject = ['remote', 'shortcuts', 'sessions']
    exports.apply = apply
    return module.exports
  },
})
