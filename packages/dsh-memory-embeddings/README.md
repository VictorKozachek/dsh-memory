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
  enabled: false
  provider: ""                 # local | ollama | openai-compatible
  base_url: ""
  model: ""
  api_key_env: DSH_MEMORY_EMBEDDINGS_API_KEY
  batch_size: 32
  timeout_ms: 5000
  max_retries: 2
  hybrid_weight: 0.5
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
- `provider: openai-compatible` — `POST {base_url}/embeddings`; ключ читается из
  `env[api_key_env]`, в БД/логи/ошибки не попадает; ошибки редактируются.
- `provider: ollama` — локальный Ollama (`http://127.0.0.1:11434` по умолчанию).
- Без ключа/`base_url`/модели провайдер не создаётся: пакет пишет `warn`,
  `doctor`-строки объясняют причину, поиск откатывается на FTS5. Загрузка
  профиля не падает.
- `DSH_MEMORY_NO_NETWORK=1` (`true`/`on`/`yes`) запрещает egress: API и Ollama
  не вызываются, локальный провайдер работает.

## Doctor и приватность

При включённом сетевом провайдере пакет пишет предупреждение:
«запросы и тексты записей будут отправлены провайдеру …, ключ берётся из env
`<ENV>` (значение не показывается)». Это же отдаёт `doctorReport()` для будущей
команды `doctor`. Локальный провайдер предупреждений не требует.

## Ограничения этой версии

- Синхронный канал поиска зарегистрирован для локального провайдера; для
  API/Ollama в этой версии работает фоновый досчёт векторов, async query-канал —
  следующий шаг (дизайн 021).
- Нейросетевая локальная модель (ONNX/WASM) не входит в пакет: нужен отдельный
  model-артефакт и зависимости.
- Нет ANN: brute-force косинус; порог перехода на `sqlite-vec` — по замеру
  (дизайн 021, >50k векторов / p95 > 50 мс).

Отчёт сравнения с FTS5: [docs/benchmark-embeddings.md](../../docs/benchmark-embeddings.md).
