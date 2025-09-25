# Codex MCP Server

Model Context Protocol server для OpenAI Codex CLI. Дозволяє використовувати Codex через MCP протокол в Claude Desktop, n8n та інших системах.

## Особливості

- 🚀 Мінімальні залежності (тільки MCP SDK)
- 🐳 Готовий Docker образ
- 🔧 Підтримка всіх основних Codex функцій
- 📁 Персістентні робочі простори
- 🔒 Безпечне виконання в контейнері

## Швидкий старт

### Docker

```bash
# Збудувати образ
docker build -t codex-mcp-server .

# Запустити з Claude Desktop (stdio mode)
docker run -i --rm \
  -e OPENAI_API_KEY=your_api_key \
  -v $(pwd)/workspace:/workspace \
  codex-mcp-server
```

### Локально

```bash
# Встановити залежності
npm install

# Встановити Codex CLI
npm install -g @openai/codex@native

# Запустити сервер
OPENAI_API_KEY=your_api_key node server.js
```

## Конфігурація Claude Desktop

Додайте до вашого `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "codex": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "OPENAI_API_KEY=your_api_key",
        "-v", "/path/to/workspace:/workspace",
        "codex-mcp-server"
      ]
    }
  }
}
```

## Доступні інструменти

### `codex_completion`
Загальне виконання Codex з довільним промптом.

**Параметри:**
- `prompt` (обов'язковий): Промпт для Codex
- `model` (опціонально): Модель для використання
- `images` (опціонально): Масив шляхів до зображень
- `project_path` (опціонально): Шлях до проекту для персістентного робочого простору

### `write_code`
Генерація коду для конкретного завдання.

**Параметри:**
- `task` (обов'язковий): Опис завдання
- `language` (обов'язковий): Мова програмування
- `model` (опціонально): Модель для використання
- `project_path` (опціонально): Шлях до проекту

### `explain_code`
Детальне пояснення як працює код.

**Параметри:**
- `code` (обов'язковий): Код для пояснення
- `model` (опціонально): Модель для використання
- `project_path` (опціонально): Шлях до проекту

### `debug_code`
Пошук та виправлення помилок в коді.

**Параметри:**
- `code` (обов'язковий): Код для дебагу
- `issue_description` (опціонально): Опис проблеми
- `model` (опціонально): Модель для використання
- `project_path` (опціонально): Шлях до проекту

## Змінні середовища

- `OPENAI_API_KEY` - API ключ OpenAI (обов'язковий)
- `WORKSPACE_ROOT` - Корінь робочого простору (за замовчуванням: `/workspace`)
- `LOG_LEVEL` - Рівень логування (`debug`, `info`, `warn`, `error`, `silent`)

## Deployment в CapRover

1. Створіть новий додаток в CapRover
2. Встановіть змінні середовища:
   - `OPENAI_API_KEY=your_api_key`
   - `WORKSPACE_ROOT=/app/workspace`
3. Deploy цей проект як Docker образ

## Розробка

```bash
# Встановити dev залежності
npm install

# Запустити в режимі розробки
npm run dev
```

## Ліцензія

MIT
