// Harness for the client bundle: the browser globals are faked, the real bundle is
// executed in a vm context, and the registered shortcuts are driven by hand.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const SOURCE = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')

const CATALOG = {
  maxAudioBytes: 20 * 1024 * 1024,
  maxDurationSeconds: 600,
  selection: { providerId: 'gigaam-local', language: 'ru' },
  providers: [],
}

const FRAME = 2048 // 128 ms at 16 kHz

function speech(frames = 3) {
  return Array.from({ length: frames }, () => Float32Array.from({ length: FRAME }, () => 0.1))
}

function silence(frames = 5) {
  return Array.from({ length: frames }, () => Float32Array.from({ length: FRAME }, () => 0.0005))
}

function createWindow() {
  const listeners = new Map()
  const window = {
    __ModuleLoader__: {
      load({ id, factory }) {
        window.registered = { id, exports: factory() }
      },
    },
    addEventListener(type, handler) {
      const bucket = listeners.get(type) ?? []
      bucket.push(handler)
      listeners.set(type, bucket)
    },
    removeEventListener(type, handler) {
      listeners.set(type, (listeners.get(type) ?? []).filter((entry) => entry !== handler))
    },
    dispatch(type, event) {
      for (const handler of listeners.get(type) ?? []) handler({ preventDefault() {}, stopPropagation() {}, ...event })
    },
  }
  return window
}

function createRuntime({ transcript = 'привет мир', transcripts, sent = [], config } = {}) {
  const window = createWindow()
  const counters = { recorderStarts: 0, requests: [] }
  const state = { processor: undefined }
  const queue = transcripts === undefined ? undefined : [...transcripts]

  class FakeRecorder {
    constructor(stream) {
      this.stream = stream
      this.state = 'inactive'
      this.mimeType = 'audio/webm'
    }
    start() {
      this.state = 'recording'
      counters.recorderStarts += 1
    }
    stop() {
      if (this.state !== 'recording') return
      this.state = 'inactive'
      this.ondataavailable?.({ data: new Blob([new Uint8Array(4000)]) })
      this.onstop?.()
    }
  }

  class FakeAudioContext {
    constructor(options = {}) {
      this.sampleRate = options.sampleRate ?? 16000
      this.state = 'running'
      this.currentTime = 0
      this.destination = { connect() {} }
    }
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} }
    }
    createScriptProcessor() {
      const node = { onaudioprocess: null, connect() {}, disconnect() {} }
      state.processor = node
      return node
    }
    createGain() {
      return { gain: { value: 1 }, connect() {}, disconnect() {} }
    }
    createOscillator() {
      return { frequency: { value: 0 }, connect() {}, start() {}, stop() {} }
    }
    async decodeAudioData() {
      return { duration: 1.2 }
    }
    async close() {
      this.state = 'closed'
    }
  }

  class FakeOfflineAudioContext {
    constructor(_channels, length) {
      this.length = length
    }
    createBufferSource() {
      return { connect() {}, start() {}, buffer: null }
    }
    async startRendering() {
      return { getChannelData: () => new Float32Array(this.length) }
    }
  }

  const sandbox = {
    window,
    console,
    setTimeout,
    clearTimeout,
    btoa,
    Blob,
    AbortController,
    MediaRecorder: FakeRecorder,
    AudioContext: FakeAudioContext,
    OfflineAudioContext: FakeOfflineAudioContext,
    navigator: {
      mediaDevices: {
        async getUserMedia() {
          return { getTracks: () => [{ stop() {} }] }
        },
      },
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(SOURCE, sandbox, { filename: 'client.js' })

  const conversation = { send: async (text) => sent.push(text) }
  const scope = {
    effect(fn) {
      return fn()
    },
    shortcuts: {
      register(command) {
        scope.commands.push(command)
        return () => {}
      },
    },
    commands: [],
    remote: {
      speech: {
        async catalog() {
          return { ok: true, value: CATALOG }
        },
        async transcribe(request) {
          counters.requests.push(request)
          const text = queue === undefined ? transcript : queue.shift() ?? ''
          return { ok: true, value: { text, audioSeconds: 1.2, inferenceSeconds: 0.1 } }
        },
      },
    },
    sessions: {
      list: { getSnapshot: () => ({ ids: ['s1'], byId: { s1: { retainedBy: { mainView: 1 } } } }) },
      scope: () => ({ get: (name) => (name === 'conversation' ? conversation : undefined) }),
    },
  }
  const ctx = { inject: (_deps, callback) => callback(scope) }
  sandbox.window.registered.exports.apply(ctx, config)

  const feed = (frames) => {
    const processor = state.processor
    assert.ok(processor?.onaudioprocess, 'the listener must install an audio processor')
    for (const frame of frames) processor.onaudioprocess({ inputBuffer: { getChannelData: () => frame } })
  }

  return { window, scope, counters, state, feed }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await sleep(5)
  }
  throw new Error(`timeout waiting for ${label}`)
}

const command = (scope, id) => scope.commands.find((entry) => entry.id === id)

test('registers dictation and listener commands with web and desktop defaults', () => {
  const { scope } = createRuntime()
  const hold = command(scope, 'voice.dictateHold')
  const toggle = command(scope, 'voice.dictateToggle')
  const listen = command(scope, 'voice.listen')
  assert.ok(hold, 'hold command registered')
  assert.ok(toggle, 'toggle command registered')
  assert.ok(listen, 'listen command registered')
  assert.equal(hold.defaults['web:windows'].modifiers.join(','), 'primary,shift')
  assert.equal(hold.defaults['web:windows'].code, 'KeyV')
  assert.equal(listen.defaults['web:windows'].code, 'KeyL')
  assert.equal(listen.defaults['web:windows'].modifiers.join(','), 'primary,shift')
  assert.equal(hold.defaults['desktop:windows'].code, 'F9')
  assert.equal(toggle.defaults['desktop:windows'].code, 'F10')
  assert.equal(listen.defaults['desktop:windows'].code, 'F8')
})

test('push-to-talk: press, speak, release sends the transcript', async () => {
  const sent = []
  const { window, scope, counters } = createRuntime({ sent })
  const hold = command(scope, 'voice.dictateHold')

  window.dispatch('keydown', { code: 'KeyV', repeat: false })
  const resolution = hold.resolve()
  assert.equal(resolution.status, 'handled')
  resolution.run()
  await waitFor(() => counters.recorderStarts === 1, 'recording to start')

  window.dispatch('keyup', { code: 'KeyV' })
  await waitFor(() => sent.length === 1, 'the transcript to be sent')

  assert.deepEqual(sent, ['привет мир'])
  assert.equal(counters.requests.length, 1)
  assert.equal(counters.requests[0].providerId, 'gigaam-local')
  assert.ok(counters.requests[0].audioBase64.length > 0)
})

test('push-to-talk ignores the release of an unrelated key', async () => {
  const sent = []
  const { window, scope, counters } = createRuntime({ sent })
  const hold = command(scope, 'voice.dictateHold')

  window.dispatch('keydown', { code: 'KeyV', repeat: false })
  hold.resolve().run()
  await waitFor(() => counters.recorderStarts === 1, 'recording to start')

  window.dispatch('keyup', { code: 'KeyN' })
  await sleep(40)
  assert.equal(sent.length, 0, 'a foreign keyup must not stop the recording')

  window.dispatch('keyup', { code: 'KeyV' })
  await waitFor(() => sent.length === 1, 'the transcript to be sent')
})

test('toggle: first press records, second press sends', async () => {
  const sent = []
  const { scope, counters } = createRuntime({ sent })
  const toggle = command(scope, 'voice.dictateToggle')

  toggle.resolve().run()
  await waitFor(() => counters.recorderStarts === 1, 'recording to start')

  const second = toggle.resolve()
  assert.equal(second.status, 'handled')
  second.run()
  await waitFor(() => sent.length === 1, 'the transcript to be sent')
  assert.deepEqual(sent, ['привет мир'])
})

test('an empty transcript is not sent', async () => {
  const sent = []
  const { window, scope, counters } = createRuntime({ sent, transcript: '' })
  const hold = command(scope, 'voice.dictateHold')

  window.dispatch('keydown', { code: 'KeyV', repeat: false })
  hold.resolve().run()
  await waitFor(() => counters.recorderStarts === 1, 'recording to start')
  window.dispatch('keyup', { code: 'KeyV' })
  await waitFor(() => counters.requests.length === 1, 'the transcription request')
  await sleep(40)
  assert.deepEqual(sent, [])
})

test('voice activation: wake phrase arms dictation, the next phrase is sent', async () => {
  const sent = []
  const { scope, counters, state, feed } = createRuntime({
    sent,
    transcripts: ['Эй, Гигам!', 'Купи хлеб.'],
    config: { sendDelayMs: 30 },
  })
  const listen = command(scope, 'voice.listen')
  const resolution = listen.resolve()
  assert.equal(resolution.status, 'handled')
  resolution.run()
  await waitFor(() => typeof state.processor?.onaudioprocess === 'function', 'listener start')

  feed([...speech(), ...silence()])
  await waitFor(() => counters.requests.length === 1, 'wake phrase transcription')
  await sleep(20)

  feed([...speech(), ...silence()])
  await waitFor(() => sent.length === 1, 'the dictated phrase to be sent')
  assert.deepEqual(sent, ['Купи хлеб.'])
  assert.equal(counters.requests.length, 2, 'both segments went through the model')
})

test('voice activation: phrase with a tail is sent in one go', async () => {
  const sent = []
  const { scope, counters, state, feed } = createRuntime({
    sent,
    transcripts: ['Эй, Гигам, купи хлеб'],
    config: { sendDelayMs: 30 },
  })
  command(scope, 'voice.listen').resolve().run()
  await waitFor(() => typeof state.processor?.onaudioprocess === 'function', 'listener start')

  feed([...speech(), ...silence()])
  await waitFor(() => sent.length === 1, 'the tail to be sent')
  assert.deepEqual(sent, ['купи хлеб'])
})

test('voice activation: Escape stops listening', async () => {
  const sent = []
  const { window, scope, counters, state } = createRuntime({
    sent,
    transcripts: ['Эй, Гигам'],
    config: { sendDelayMs: 30 },
  })
  command(scope, 'voice.listen').resolve().run()
  await waitFor(() => typeof state.processor?.onaudioprocess === 'function', 'listener start')

  window.dispatch('keydown', { code: 'Escape', repeat: false })
  await waitFor(() => state.processor.onaudioprocess === null, 'the listener to be released')
  await sleep(40)
  assert.equal(counters.requests.length, 0, 'a stopped listener must not transcribe')
  assert.deepEqual(sent, [])
})

test('package manifest exposes the client bundle under the package id', () => {
  const root = new URL('..', import.meta.url)
  const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.ok(Array.isArray(manifest.dsh.client.inject))
  assert.equal(manifest.exports['./client'], './lib/client.js')
  assert.ok(readFileSync(new URL(manifest.exports['./client'], root), 'utf8').includes(`id: '${manifest.name}'`))
  assert.ok(
    readFileSync(new URL('cordis.patch.yml', root), 'utf8').includes(`name: ${manifest.name}`),
    'the profile patch mounts the package itself so the client half loads',
  )
})
