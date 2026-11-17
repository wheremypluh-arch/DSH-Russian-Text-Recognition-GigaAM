// dsh-voice-ru — host half.
//
// Recognition is mounted by the rows this bundle inserts (see cordis.patch.yml):
// the `dsh-gigaam-stt` provider owns the engine, and the stock DSH speech service
// owns the Remote. This module only exists so the profile mounts the package: the
// web plugin table then serves the package's client half (`./client`), which adds
// the dictation hotkeys. Nothing runs here.
export const name = 'dsh-voice-ru'

export function apply() {}
