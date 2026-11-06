# Interactive Render & Secret Vault (`interactive-render`)

Use the `interactive-render_mcp` MCP tools (`render_page`, `request_secret`, `render_status`) and the `[Render](sidecar://interactive-render/render/)` side panel whenever you need **two-way interactive UI forms/visualizations** or **zero-context secret collection**:

1. **Zero-Context Secret Collection (`request_secret({ label, reason, placeholder? })`)**:
   - **NEVER ask the user to paste an API key, token, or password in the chat**, as chat messages stay in the LLM context window and conversation transcript forever.
   - Instead, call `request_secret({ label, reason, placeholder? })`. The user fills in a private masked card in the `[Render](sidecar://interactive-render/render/)` side panel, and the tool returns **only the path to a `0600` local file** (automatically deleted after 24 hours).
   - Read the file directly inside the command that needs it (e.g., `TOKEN="$(cat <file>)" some-cli ...`); never echo, print, or copy the secret into the repository. If you need to recover the file path of an already-saved secret within its 24h TTL, call `render_status({ action: "list" })` (which exposes `answerData.file` / `secretFile` while the file exists, never the secret value).

2. **Two-Way Interactive Pages & UI Blocks (`render_page({ ui?, html?, title?, awaitAnswer?, directory? })`, `render_status({ action?: "list"|"get"|"clear", pageId? })`)**:
   - **Declarative `ui` Blocks (Preferred for Questions, Forms, Tables, and Charts)**:
     - Pass `ui` using `openui-lang` syntax (supports both positional arguments and `key: value` named arguments, e.g., `Stack([Card("Title", [Choice("mode", ["Fast", "Thorough"], label: "Execution Mode"), Button("Apply", "primary", "apply")])])`) with `awaitAnswer: true` or `false`.
     - If your `ui` syntax has an error, the tool returns `reason: "ui-not-drawn"` with `errors` immediately so you can fix and re-call `render_page` in the same turn.
   - **Custom `html` Mockups & Interactive Drawings**:
     - Pass a self-contained `html` document using the built-in `.oc-box`, `.oc-table`, `.oc-options`, `.oc-option`, `.oc-button`, `.oc-field`, `.oc-input`, `.oc-switch`, `.oc-segmented`, `.oc-badge`, `.oc-dot`, `.oc-bar` classes and theme CSS variables (`--background`, `--foreground`, `--primary`, `--chart-1..6`).
     - With `awaitAnswer: true`, call `openchamber.submit(data, summary)` (or `antigravity.submit(data, summary)`) inside a button click handler to return structured JSON directly to your tool call, or let the user click **Annotate** in the panel to pick elements and send visual revision notes back to you.
     - Both `ui` and `html` modes return `embedPath`, which you can optionally embed inline in your reply via `<agent-embed src="file:///..."></agent-embed>`.
