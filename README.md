<p align="center">
  <img src="assets/images/banner.jpg" alt="pi-agent-browser banner" style="max-width: 100%; border-radius: 10px;" />
</p>

# 🌐 pi-agent-browser

**Give your AI a real browser.** A [pi](https://github.com/mariozechner/pi-coding-agent) extension that lets the LLM navigate, interact with, and see web pages through a fully automated Chromium instance.

```
You: Find the top story on Hacker News and summarize it

  browser  open https://news.ycombinator.com
  ✓ 30 interactive elements

  browser  snapshot -i
  ✓ 30 interactive elements

  browser  click @e3
  ✓ Navigated to article

  browser  screenshot
  ✓ Screenshot saved: /tmp/screenshot-1707441234.png

  browser  close
  ✓ Browser closed
```

---

## Install

```bash
pi install npm:pi-agent-browser
```

Or try it without installing:

```bash
pi -e npm:pi-agent-browser
```

That's it. On first use, the extension will offer to install [agent-browser](https://www.npmjs.com/package/agent-browser) and download Chromium automatically.

## How It Works

The extension registers a **`browser`** tool that the LLM can call. Under the hood, each call runs an [agent-browser](https://www.npmjs.com/package/agent-browser) CLI command against a persistent Chromium session.

```
┌─────────────┐     ┌──────────────────┐     ┌────────────────┐
│  LLM calls  │────▶│  pi-agent-browser │────▶│  agent-browser  │
│  browser()  │     │  (this extension) │     │  CLI + Chromium │
└─────────────┘     └──────────────────┘     └────────────────┘
                           │
                    ┌──────┴──────┐
                    │  Returns:   │
                    │  • text     │
                    │  • images   │
                    │  • @refs    │
                    └─────────────┘
```

The typical workflow the LLM follows:

1. **`open <url>`** — Navigate to a page
2. **`snapshot -i`** — Get interactive elements with `@ref` handles (e.g. `@e1`, `@e2`)
3. **Interact** — `click @e1`, `fill @e2 "query"`, `press Enter`
4. **Re-snapshot** — See what changed after interaction
5. **`screenshot`** — Get a visual of the page (returned as an inline image)
6. **`close`** — Done

### ⚡ Command Batching

Reduce round-trips by sending multiple commands in a single call. Three ways to batch:

```
// 1. Array of commands (recommended)
browser commands: ["open https://google.com", "snapshot -i", "screenshot"]

// 2. Semicolon-separated string
browser command: "open https://google.com; snapshot -i; screenshot"

// 3. Single command (backward compatible)
browser open https://google.com
```

When batching, commands execute sequentially. If one fails, the batch stops (fail-fast). Results include a summary with per-command status and any screenshots.

## Features

### 📸 Inline Screenshots

Screenshots are returned as base64 images directly to the LLM. With a vision-capable model, the AI can literally *see* the page and describe what's on screen.

### 🔍 Smart Snapshots with @refs

The `snapshot -i` command returns a structured list of interactive elements, each tagged with a clickable `@ref` handle. The LLM uses these to interact with buttons, links, inputs, and more — no CSS selectors or XPath needed.

### 📏 Output Truncation

Complex pages can produce enormous snapshot output. Large results are automatically truncated to fit context windows, with the full output saved to a temp file for reference.

### 🔧 Auto-Install

No setup required. If `agent-browser` isn't found on first use, the extension prompts to install it (npm package + Chromium binary) — all from within pi.

### 🧹 Session Cleanup

The browser is automatically closed when the pi session ends. No orphaned Chromium processes left behind.

### 🎨 Custom TUI Rendering

Tool calls display cleanly in pi's terminal UI:
- Commands show as `browser open https://example.com`
- Snapshots show element counts: `✓ 30 interactive elements`
- Screenshots show the saved path
- Errors are highlighted in red

## Command Reference

| Command | Description | Example |
|---|---|---|
| `open <url>` | Navigate to a URL | `open https://example.com` |
| `snapshot -i` | List interactive elements with `@ref` handles | `snapshot -i` |
| `click <@ref>` | Click an element | `click @e3` |
| `fill <@ref> <text>` | Clear field and type text | `fill @e5 "search query"` |
| `type <@ref> <text>` | Type text without clearing | `type @e5 "more text"` |
| `select <@ref> <value>` | Select a dropdown option | `select @e7 "Option B"` |
| `press <key>` | Press a keyboard key | `press Enter` |
| `scroll <dir> [px]` | Scroll the page | `scroll down 500` |
| `get text\|url\|title [@ref]` | Get page or element info | `get title` |
| `wait <@ref\|ms>` | Wait for element or time | `wait 2000` |
| `screenshot [--full]` | Take a screenshot (returned inline) | `screenshot --full` |
| `close` | Close the browser session | `close` |

Any valid [agent-browser](https://www.npmjs.com/package/agent-browser) command works — the extension passes it through directly.

## Examples

### Search the web (with batching)

```
You: Search Google for "pi coding agent" and tell me the first result

  browser  commands: ["open https://www.google.com", "snapshot -i", "fill @e3 pi coding agent", "press Enter", "snapshot -i", "close"]

Executed 6 of 6 commands | 45 interactive elements in last snapshot

The first result is...
```

### Search the web (semicolon batch)

```
You: Search Google for "pi coding agent"

  browser  command: "open https://www.google.com; snapshot -i; fill @e3 pi coding agent; press Enter; snapshot -i; close"

Executed 6 of 6 commands | 45 interactive elements in last snapshot

The first result is...
```

### Fill out a form (with batching)

```
You: Go to httpbin.org/forms/post and fill out the form

  browser  commands: ["open https://httpbin.org/forms/post", "snapshot -i", "fill @e1 John", "fill @e2 john@example.com", "click @e5", "close"]
```

### Take a visual snapshot

```
You: Show me what the Anthropic homepage looks like

  browser  commands: ["open https://www.anthropic.com", "screenshot", "close"]
  // LLM sees the page and describes layout, content, design...

The Anthropic homepage features a clean design with...
```

## Requirements

- **Node.js** ≥ 20
- **[pi](https://github.com/mariozechner/pi-coding-agent)** — the coding agent this extends
- **[agent-browser](https://www.npmjs.com/package/agent-browser)** — installed automatically on first use, or manually:
  ```bash
  npm install -g agent-browser
  agent-browser install   # downloads Chromium
  ```
- **Vision-capable model** (for screenshots): Claude Sonnet/Opus, GPT-4o, Gemini Pro, etc.

## Architecture

```
pi-agent-browser/
├── extensions/
│   └── agent-browser.ts    # The pi extension (single file, ~450 lines)
├── docs/
│   └── plans/              # Implementation plans
├── package.json            # pi package manifest
├── LICENSE                 # MIT
└── README.md
```

The extension is a single TypeScript file that:

1. **Registers** the `browser` tool with pi's extension API
2. **Auto-detects** agent-browser installation, prompts to install if missing
3. **Executes** commands via `pi.exec("agent-browser", [...args])`
4. **Handles screenshots** by reading the saved image and returning it as base64
5. **Truncates** large outputs to protect context windows
6. **Renders** results with custom TUI formatting
7. **Cleans up** the browser on `session_shutdown`
8. **Batches** multiple commands: array (`commands: [...]`), semicolons (`"cmd1; cmd2"`), or single `command` string — fail-fast on errors

## Troubleshooting

### "agent-browser not found"

The extension will prompt to install automatically. If that fails, install manually:

```bash
npm install -g agent-browser
agent-browser install
```

### Chromium won't start

Make sure Chromium dependencies are installed. On Debian/Ubuntu:

```bash
sudo apt-get install -y libx11-xcb1 libxcomposite1 libxdamage1 libxi6 \
  libxtst6 libnss3 libcups2 libxrandr2 libasound2 libpangocairo-1.0-0 \
  libatk1.0-0 libatk-bridge2.0-0 libgtk-3-0
```

Or run in headless mode (agent-browser's default).

### Screenshots aren't working with my model

Screenshots require a **vision-capable model**. Make sure you're using one of:
- Claude 3.5 Sonnet, Claude 3 Opus, Claude 4 Sonnet/Opus
- GPT-4o, GPT-4 Turbo
- Gemini 1.5 Pro, Gemini 2.0 Pro

### Large pages produce truncated snapshots

This is by design. The full output is saved to a temp file (path shown in the truncation notice). The LLM usually has enough context from the truncated output to continue working.

### Browser left running after crash

If pi exits unexpectedly, you may need to clean up manually:

```bash
agent-browser close
# or
pkill -f chromium
```

## Contributing

Contributions welcome! This is a straightforward single-file extension — the entire implementation lives in `extensions/agent-browser.ts`.

```bash
git clone https://github.com/coctostan/pi-agent-browser.git
cd pi-agent-browser

# Test locally
pi -e extensions/agent-browser.ts
```

## License

[MIT](LICENSE)
