# dsh-voice-ru

Русский голосовой ввод для [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) одним бандлом:
локальное распознавание **GigaAM v3** на CPU, оффлайн, без API-ключей. Кнопка микрофона в композере
начинает диктовать по-русски — с пунктуацией и цифрами.

Проверено на DSH `0.2.2-rc.1`, Node.js 24, Windows x64.

## Что внутри

Пакет — bundle-бандл: своего кода распознавания он не содержит, только компонует профиль DSH
(`cordis.patch.yml`). Движок — пакет [`dsh-gigaam-stt`](https://www.npmjs.com/package/dsh-gigaam-stt)
(GigaAM v3 `e2e_ctc` int8 через `sherpa-onnx`, который идёт в комплекте с DSH).

| id строки | что даёт |
| --- | --- |
| `speech-to-text` | сервис распознавания: `defaultProvider: gigaam-local`, `language: ru` |
| `speech-to-text-gigaam` | локальный провайдер, модель в `$DSH_HOME/speech-to-text/gigaam` |
| `api-speech-to-text` | Remote для браузера, лимит записи 600 с / 20 МиБ (штатные 120 с / 4 МиБ) |
| `ui-voice-input` | кнопка микрофона в композере |

## Важно перед установкой

**Не включайте одновременно официальный `@deepseek-ai/dsh-experimental-voice-input-bundle`.**
Оба бандла вставляют строку с id `speech-to-text`, композиция профиля упадёт на дубликате.
Этот бандл заменяет официальный voice input целиком, а не дополняет его.

Если официальный voice input уже включён — сначала уберите его из `dsh.profile.bundles`
в `$DSH_HOME/profiles/<профиль>/package.json`.

## Установка

Из git-репозитория (профиль по умолчанию — `web`):

```bash
dsh plugin --profile web add github:wheremypluh-arch/DSH-Russian-Text-Recognition-GigaAM
```

Или в Web UI: **Plugins** → поле установки → `github:wheremypluh-arch/DSH-Russian-Text-Recognition-GigaAM`.
UI сам зарегистрирует бандл в профиле.

При установке из CLI имя бандла нужно добавить в `$DSH_HOME/profiles/web/package.json` вручную:

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-voice-ru"]
    }
  }
}
```

### Поиск в DSH Discover

В репозитории лежит [index.json](index.json) — индекс формата 1 для Discover. Чтобы плагин
находился поиском, включите `@deepseek-ai/dsh-experimental-plugin-market-bundle`
(Plugins → Custom plugin indexes) и добавьте источник:

```
https://raw.githubusercontent.com/wheremypluh-arch/DSH-Russian-Text-Recognition-GigaAM/main/index.json
```

После этого «русский», «russian», «voice» находят плагин во вкладке Discover.

## Первый запуск

Перезапустить DSH, открыть чат, нажать микрофон. Карточка подготовки скачает ~320 МБ модели
в `$DSH_HOME/speech-to-text/gigaam/` (сначала `huggingface.co`, при недоступности `hf-mirror.com`),
сверит SHA-256 и загрузит движок (~1 с). Дальше всё работает оффлайн, модель выгружается
из памяти после 5 минут простоя.

Требования:

- DSH `>=0.2.2-rc.1` (профиль с `nodeLinker: hoisted` — штатный дефолт) и Node.js 22+;
- доступ к npm registry (зависимость `dsh-gigaam-stt`) и к `huggingface.co` либо `hf-mirror.com` (модель);
- ~350 МБ на диске, ~520 МБ RAM во время распознавания;
- разрешение браузера на микрофон для origin DSH Web.

## Настройка

Переопределяйте строку `speech-to-text-gigaam` в `$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- id: speech-to-text-gigaam
  config:
    threads: 2
    maxSegmentSeconds: 20
    numbers: words
```

Полный список параметров, включая зеркала загрузки модели, — в README пакета `dsh-gigaam-stt`.

## Лицензии

Этот бандл — MIT. Движок `dsh-gigaam-stt` — MIT, модель GigaAM v3 — MIT (ai-sage),
`sherpa-onnx` распространяется вместе с DSH.
