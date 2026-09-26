# supabase/

Схема БД ChartSwipe (architecture.md §6): миграции, RLS, триггеры.

| Файл | Что внутри |
|---|---|
| `migrations/20260926000000_init.sql` | 5 таблиц (`watchlists`, `levels`, `symbol_map`, `api_keys`, `push_subscriptions`), триггер `updated_at`, индексы, RLS |
| `migrations/20260927000000_levels_tf_1w.sql` | `levels.tf` += `'1w'` (недельный ТФ, кнопка «Н»); пересоздаёт `levels_tf_check` |
| `seed.sql` | Пустой сид (реальные `user_id` не коммитим); закомментированный пример данных |

## Как применить

### Вариант A — Supabase CLI
```bash
npx supabase login
npx supabase link --project-ref <project-ref>
npx supabase db push          # применяет supabase/migrations/*.sql
```
Локально (нужен Docker): `npx supabase start` → `npx supabase db reset` (миграции + `seed.sql`).

### Вариант B — SQL Editor
Запасной путь; основной — вариант A. Открыть Supabase Dashboard → SQL Editor, вставить содержимое каждой миграции из `migrations/` по порядку имён целиком и выполнить по одному разу.

**Обязательно после этого** пометить миграции применёнными, иначе следующий `supabase db push` попытается выполнить их повторно и упадёт с `relation "watchlists" already exists`:
```bash
npx supabase link --project-ref <project-ref>
npx supabase migration repair --status applied 20260926000000
npx supabase migration repair --status applied 20260927000000
```

## Ключевые правила схемы
- `levels`: только мягкое удаление (`deleted_at = now()`): у `authenticated` нет права `DELETE` и нет delete-политики; строки удаляет только каскад из `auth.users`.
- `updated_at` в `levels` и `watchlists` ставит триггер `before insert or update` = `now()` всегда (значение клиента игнорируется) — это курсор синка MT5 (ADR A6). `created_at` при update неизменен, при insert не позже `now()`.
- `levels`: `price > 0`, `price_to` есть тогда и только тогда, когда `kind = 'zone'`, и для зоны `price_to > price`; `note` ≤ 140 символов, `tf ∈ {5m,1h,1d,1w}`, `color` — `#RRGGBB` (в BGR переводит API, ADR A7).
- `watchlists`: имя уникально в пределах пользователя (`on conflict (user_id, name)`), не более 500 тикеров в списке.
- `api_keys`: клиентский update разрешён только для `name`, `revoked_at`; отзыв необратим, `key_hash` неизменяем (триггер `api_keys_guard`).
- Права выданы явно в миграции (не полагаемся на default grants Supabase); `anon` не имеет доступа ни к одной таблице.
- `symbol_map.target ∈ {mt5, tv}`, уникально по `(user_id, symbol, target)`.
- `api_keys.key_hash` — sha256 в hex (64 символа), уникальный индекс; открытый ключ не хранится.
- RLS включён везде: `user_id = (select auth.uid())` для select/insert/update/delete (у `levels` без delete), роль `authenticated`. `user_id` по умолчанию = `auth.uid()`.
- Service role (обходит RLS) — только в бэкенде, только в sync-эндпоинтах по API-ключу. Никогда не кладите service role key в клиент.

## Проверка без облака
`validate/validate.sh` поднимает `postgres:15` в Docker, создаёт заглушки `auth.users`/`auth.uid()`/ролей Supabase, применяет миграцию и прогоняет проверки ограничений, триггера и RLS.
```bash
bash supabase/validate/validate.sh
```
