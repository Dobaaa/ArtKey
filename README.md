# Intelligent Writing Studio

A browser writing studio built with React + TypeScript + Vite, focused on:

- fast Markdown editing with syntax-aware rendering
- Copilot-like Gemini ghost text autocomplete
- multi-tab document management with per-tab history/state
- Web Worker markdown preview
- command palette, themes, and status metrics

## Local setup

1. Install dependencies
   - `npm install`
2. Create `.env` in the project root:
   - `VITE_GEMINI_API_KEY=your_google_ai_studio_key`
3. Start dev server
   - `npm run dev`

## Build and checks

- `npm run lint`
- `npm run build`

## Architecture notes

- **State model**: Zustand store (`src/studio/store.ts`) with isolated document state (content, selection, scroll, undo/redo, dirty flag).
- **Persistence**: autosaves via `requestIdleCallback` (fallback to `setTimeout`) into `localStorage`, then restores on reload.
- **AI autocomplete**: `src/studio/gemini.ts` streams Gemini tokens, deduplicates in-flight identical prompts, and supports cancellation via `AbortController`.
- **Preview performance**: markdown parsing runs in `src/studio/markdownWorker.ts`, with block-level cache to avoid re-parsing unchanged blocks.
- **UI shell**: `src/studio/WritingStudio.tsx` handles tabs, toolbar, command palette, find/replace, split pane, and status bar.
- **Design tokens**: all colors/spacing/typography/shadows in CSS custom properties (`src/styles.css`) with light/dark/sepia themes.

## Trade-offs

- The editor uses a textarea + syntax overlay approach for speed and simplicity.
- Ghost text currently renders as an overlay in the editor pane (Copilot behavior is implemented, placement is intentionally lightweight).
- Scroll syncing between editor and preview is direct `scrollTop` syncing; for very different rendered heights, a ratio-based sync can be added.

## Deploy

Deploy on Vercel as a Vite app:

1. Import repo
2. Set environment variable `VITE_GEMINI_API_KEY`
3. Build command: `npm run build`
4. Output directory: `dist`
