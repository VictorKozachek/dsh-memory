# dsh-memory-embeddings

Опциональный пакет к [`dsh-memory`](../../README.md): локальные или
API-эмбеддинги и гибридный поиск (BM25 + косинус). Основной пакет остаётся без
сети, ключей и провайдеров; **по умолчанию пакет выключен**, поиск — чистый
FTS5.

## Установка

Пакет ставится в профиль DSH как обычный bundle:
`dsh plugin --profile <имя> add dsh-memory-embeddings` (или установка из
локального пути/пакета). Он монтируется после `dsh-memory` и использует сервис
`memory` (`storeFor`, `registerSearchChannel`).

## Конфиг

```yaml
dsh-memory-embeddings:
  enabled: true
  provider: local-onnx         # local | local-onnx | ollama | openai-compatible
  base_url: ""
  model: Xenova/multilingual-e5-small
  model_path: ""               # локальный артефакт вместо/вместо кэша
  allow_download: true         # явное согласие на первую загрузку
  cache_dir: ~/.dsh/memory/models
  api_key_env: DSH_MEMORY_EMBEDDINGS_API_KEY
  batch_size: 32
  timeout_ms: 5000
  max_retries: 2
  hybrid_weight: 0.1
```

Примеры:

```yaml
# локально и офлайн, без ключей
dsh-memory-embeddings:
  enabled: true
  provider: local
  model: local-hash-128

# OpenAI-совместимый API; ключ берётся из env, не из конфига
dsh-memory-embeddings:
  enabled: true
  provider: openai-compatible
  base_url: https://api.example.com/v1
  model: text-embedding-3-small
  api_key_env: MY_EMBEDDINGS_KEY
```

## Поведение

- `provider: local` — встроенный офлайн-эмбеддер (`local-hash-128`): слова и
  триграммы, хэшированные в 128 измерений, L2-нормализация. Сеть и ключи не
  используются; это baseline, а не нейросетевая модель (ONNX/Ollama — отдельные
  провайдеры/открытый вопрос 021). Векторы лежат в SQLite BLOB, косинус —
  brute-force.
- `provider: local-onnx` — локальная модель через `@xenova/transformers`
  (опциональная зависимость). По умолчанию `Xenova/multilingual-e5-small`:
  первый запуск скачивает веса в `cache_dir` (`allow_download:true`, прогресс в
  лог), повторный работает офлайн. `model_path` задаёт готовый локальный
  артефакт. `DSH_MEMORY_NO_NETWORK=1` запрещает скачивание, но скачанная модель
  работает; `allow_download:false` без кэша — warn и FTS5. Битый/отсутствующий
  артефакт не роняет профиль.
- `provider: openai-compatible` — `POST {base_url}/embeddings`; ключ читается из
  `env[api_key_env]`, в БД/логи/ошибки не попадает; ошибки редактируются.
- `provider: ollama` — локальный Ollama (`http://127.0.0.1:11434` по умолчанию).
- Без ключа/`base_url`/модели провайдер не создаётся: пакет пишет `warn`,
  `doctor`-строки объясняют причину, поиск откатывается на FTS5. Загрузка
  профиля не падает.
- `DSH_MEMORY_NO_NETWORK=1` (`true`/`on`/`yes`) запрещает egress: API и Ollama
  не вызываются, локальный провайдер работает.

## Требования для local-onnx

`@xenova/transformers` — optionalDependency пакета (может не установиться на
экзотической платформе); веса скачиваются при первом `embed` в `cache_dir`.
Для текстового pipeline `sharp` не используется, но если импорт
`@xenova/transformers` падает на нативном `sharp`, установите совместимый
`sharp` под платформу или задайте `model_path` с готовым артефактом.

## Doctor и приватность

При включённом сетевом провайдере пакет пишет предупреждение:
«запросы и тексты записей будут отправлены провайдеру …, ключ берётся из env
`<ENV>` (значение не показывается)». Это же отдаёт `doctorReport()` для будущей
команды `doctor`. Локальный провайдер предупреждений не требует.

## Ограничения этой версии

- Модель и кэш не входят в npm-пакет; `@xenova/transformers` — optional
  dependency. Первая загрузка требует сети и явного `allow_download:true`.
- Для локального провайдера канал синхронный; для API/Ollama — асинхронный:
  `searchMemoryAsync`/`buildMemoryBlockAsync` (hook хода) досчитывают векторы,
  считают embedding запроса и добавляют косинус к RRF. Синхронный
  `memory.search` такие каналы пропускает, не ломаясь.
- Событие `memory/entries-changed` основного пакета: async-канал помечает
  известные store грязными и досчитывает векторы только новых/изменённых
  записей на следующем поиске; локальный канал проверяет отсутствующие векторы
  лениво.
- Сервис `memory.search` в основном пакете асинхронный и ждёт async-каналы;
  для CLI/бенчмарка есть `memory.searchSync` (async-каналы пропускаются).
- `local-hash-128` — офлайн-baseline (хэши слов/триграмм), не нейросетевая
  модель. `local-onnx`/`multilingual-e5-small` — основной локальный путь; сами
  веса и `@xenova/transformers` не входят в npm-пакет (optional dependency +
  кэш `~/.dsh/memory/models`). Без загрузки/кэша остаётся FTS5; локальная
  модель также доступна через `provider: ollama` (HTTP localhost, NO_NETWORK
  его запрещает).
- Нет ANN: brute-force косинус; порог перехода на `sqlite-vec` — по замеру
  (дизайн 021, >50k векторов / p95 > 50 мс).

## Doctor

```bash
dsh-memory-embeddings doctor --config <файл.json> [--db <каталог БД> --namespace <имя>]
```

С `--db/--namespace` открывает store через `@vkozachek/dsh-memory/store` и
показывает число векторов. На apply-пути count не печатается: process.cwd
плагина не обязан совпадать с cwd хода при `namespace:auto`; используйте
doctor с явными `--db/--namespace`. Печатает, включён ли канал, провайдера/модель, `cache_dir` и статус модели
(скачана/нет), размерность, число векторов и записей без векторов, наличие
ключа в env (только имя), предупреждение о первой загрузке (~100 МБ из
Hugging Face) — ровно один раз — и причину отката на FTS5. Команда `doctor`
основного пакета — отдельная задача; этот бинарь — проверяемая точка
диагностики уже сейчас. При массовом backfill прогресс пишется в лог
(`досчёт векторов N`, `прогресс i/N`, `досчёт завершён`).

Отчёт сравнения с FTS5: [docs/benchmark-embeddings.md](../../docs/benchmark-embeddings.md).
