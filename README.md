# Interactive Render & Secret Vault (`interactive-render`)

An Antigravity 2.0 Desktop plugin inspired by OpenChamber's `render.page`, `openui-lang` UI blocks, visual frame annotation, and `secret.request` zero-context vault.

## Features

1. **Two-Way Blocking Interactive Render (`render_page` with `awaitAnswer: true`)**:
   - **Declarative `ui` Blocks (`openui-lang` + JSON AST)**: Render consistent, theme-native forms, multi-option cards, tables, progress bars, and charts (`Stack`, `Row`, `Card`, `Tabs`, `Tab`, `Details`, `Text`, `Badge`, `Callout`, `KeyValue`, `Table`, `Steps`, `BarChart`, `LineChart`, `Series`, `Stat`, `Progress`, `Choice`, `Input`, `DateInput`, `Slider`, `Button`). Automatically reports parser diagnostics (`ui-not-drawn`) back to the Agent for self-correction.
   - **Sandboxed `srcdoc` HTML Canvas**: Pre-injected with OpenChamber's `.oc-*` visual kit classes, live Dark/Light CSS variables, auto-height ResizeObserver, `openchamber.submit(data, summary)` / `antigravity.submit(data, summary)` JSON-RPC bridge, and a 25 MB local image inliner (`fitRenderPageImages`).
   - **Visual Element Annotation**: Toggle **Annotate** on any rendered HTML mockup to click elements, attach revision notes, and send structured element selectors + bounding boxes back to the waiting Agent.
   - **Dual Display**: View and interact live in the right-hand **Render** Sidecar panel (`[Render](sidecar://interactive-render/render/)`) or embed the exported standalone file in chat via `<agent-embed>`.

2. **Zero-Context Secret Request Vault (`request_secret`)**:
   - Displays a password-manager-ignored (`data-1p-ignore`, `data-lpignore="true"`, `data-bwignore`) private card in the Sidecar panel.
   - Writes the submitted secret directly to `~/.gemini/antigravity/interactive-render/secrets/<random>` with `0600` permissions (auto-deleted after 24 hours) and returns **only the file path** to the Agent so secret values never enter the LLM context window or conversation logs.

## Installation

1. Clone or copy this folder into your Antigravity plugins directory:

   ```bash
   # macOS / Linux
   git clone https://github.com/DYY-Studio/antigravity-interactive-render.git ~/.gemini/config/plugins/interactive-render
   ```

   ```powershell
   # Windows (PowerShell)
   git clone https://github.com/DYY-Studio/antigravity-interactive-render.git "$HOME\.gemini\config\plugins\interactive-render"
   ```

2. Restart Antigravity 2.0 Desktop, ensure **Interactive Render & Secret Vault** is enabled in **Customizations → Plugins**, and open the **Render** side panel.

## License

MIT
