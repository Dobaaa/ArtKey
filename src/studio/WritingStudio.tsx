import { useEffect, useMemo, useRef, useState } from "react";
import Fuse from "fuse.js";
import { nanoid } from "nanoid";
import { streamGeminiSuggestion } from "./gemini";
import { persistStudioState, useStudioStore } from "./store";
import type { DocState, EditorSelection, Theme } from "./types";

const THEMES: Theme[] = ["light", "dark", "sepia"];
const AI_DEBOUNCE_MS = 1000;
const AI_CONTEXT_CHARS = 180;
const TYPING_COOLDOWN_MS = 160;
const AI_MIN_INTERVAL_MS = 3000;
const AI_RATE_LIMIT_COOLDOWN_MS = 20000;

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function highlightMarkdown(text: string): string {
  return escapeHtml(text)
    .replace(/^(\s{0,3}#{1,6}\s.*)$/gm, '<span class="md-heading">$1</span>')
    .replace(/(\*\*[^*]+\*\*)/g, '<span class="md-strong">$1</span>')
    .replace(/(\*[^*\n]+\*)/g, '<span class="md-em">$1</span>')
    .replace(/(`[^`\n]+`)/g, '<span class="md-code">$1</span>')
    .replace(/^(\s*[-*+]\s.*)$/gm, '<span class="md-list">$1</span>')
    .replace(/^(\s*&gt;\s.*)$/gm, '<span class="md-quote">$1</span>');
}

function splitBlocks(text: string): string[] {
  return text.split(/\n{2,}/g);
}

function useWorkerPreview(content: string) {
  const workerRef = useRef<Worker | null>(null);
  const [html, setHtml] = useState("");

  useEffect(() => {
    workerRef.current = new Worker(new URL("./markdownWorker.ts", import.meta.url), { type: "module" });
    workerRef.current.onmessage = (event: MessageEvent<{ id: string; html: string }>) => {
      setHtml(event.data.html);
    };
    return () => workerRef.current?.terminate();
  }, []);

  useEffect(() => {
    const id = nanoid();
    workerRef.current?.postMessage({ id, blocks: splitBlocks(content) });
  }, [content]);

  return html;
}

function download(name: string, text: string, ext: "md" | "txt") {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name || "document"}.${ext}`;
  a.click();
  URL.revokeObjectURL(url);
}

export function WritingStudio() {
  const {
    docs,
    activeDocId,
    theme,
    splitRatio,
    previewVisible,
    commandPaletteOpen,
    findOpen,
    acceptanceCount,
    dismissCount,
    switchDoc,
    createDoc,
    closeDoc,
    renameDoc,
    reorderDocs,
    updateSelection,
    updateContent,
    updateScroll,
    undo,
    redo,
    setSplitRatio,
    setTheme,
    setPreviewVisible,
    setCommandPaletteOpen,
    setFindOpen,
    incrementAccepted,
    incrementDismissed,
  } = useStudioStore();

  const activeDoc = docs.find((doc) => doc.id === activeDocId) as DocState;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const dragDocId = useRef<string | null>(null);
  const [wrapEnabled, setWrapEnabled] = useState(true);
  const [showLines, setShowLines] = useState(true);
  const [ghostText, setGhostText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<number | null>(null);
  const ghostTextRef = useRef("");
  const requestRunningRef = useRef(false);
  const lastTypedAtRef = useRef(0);
  const lastRequestAtRef = useRef(0);
  const nextAllowedRequestAtRef = useRef(0);
  const [findTerm, setFindTerm] = useState("");
  const [replaceTerm, setReplaceTerm] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [lastSaveAgo, setLastSaveAgo] = useState("just now");
  const [paletteQuery, setPaletteQuery] = useState("");

  const workerHtml = useWorkerPreview(activeDoc.content);

  useEffect(() => {
    ghostTextRef.current = ghostText;
  }, [ghostText]);

  const lineCount = Math.max(1, activeDoc.content.split("\n").length);
  const words = activeDoc.content.trim() ? activeDoc.content.trim().split(/\s+/g).length : 0;
  const readingMinutes = Math.max(1, Math.ceil(words / 220));
  const acceptanceRate = acceptanceCount + dismissCount === 0 ? 0 : Math.round((acceptanceCount / (acceptanceCount + dismissCount)) * 100);
  const matches = useMemo(() => {
    if (!findTerm) return [];
    const found: Array<{ start: number; end: number }> = [];
    const source = activeDoc.content.toLowerCase();
    const needle = findTerm.toLowerCase();
    let index = source.indexOf(needle);
    while (index >= 0) {
      found.push({ start: index, end: index + findTerm.length });
      index = source.indexOf(needle, index + 1);
    }
    return found;
  }, [findTerm, activeDoc.content]);

  const actions = useMemo(
    () => [
      { id: "new", label: "New Tab", run: () => createDoc() },
      { id: "find", label: "Find", run: () => setFindOpen(true) },
      { id: "preview", label: "Toggle Preview", run: () => setPreviewVisible(!previewVisible) },
      { id: "theme", label: "Switch Theme", run: () => setTheme(THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]) },
      { id: "md", label: "Export .md", run: () => download(activeDoc.title, activeDoc.content, "md") },
      { id: "txt", label: "Export .txt", run: () => download(activeDoc.title, activeDoc.content, "txt") },
      { id: "wrap", label: "Toggle Word Wrap", run: () => setWrapEnabled((value) => !value) },
      { id: "lines", label: "Toggle Line Numbers", run: () => setShowLines((value) => !value) },
    ],
    [activeDoc.content, activeDoc.title, createDoc, previewVisible, setFindOpen, setPreviewVisible, setTheme, theme],
  );

  const fuse = useMemo(() => new Fuse(actions, { keys: ["label"], threshold: 0.4 }), [actions]);
  const filteredActions = paletteQuery ? fuse.search(paletteQuery).map((entry) => entry.item) : actions;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const unsub = useStudioStore.subscribe((state) => {
      const idle = window.requestIdleCallback ?? ((cb: IdleRequestCallback) => window.setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 10 } as IdleDeadline), 150));
      idle(() => {
        persistStudioState(state);
        state.docs.filter((doc) => doc.isDirty).forEach((doc) => state.markSaved(doc.id));
      });
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      const delta = Math.max(0, Date.now() - activeDoc.lastSavedAt);
      const seconds = Math.round(delta / 1000);
      setLastSaveAgo(seconds < 60 ? `${seconds}s ago` : `${Math.round(seconds / 60)}m ago`);
    }, 1000);
    return () => window.clearInterval(interval);
  }, [activeDoc.lastSavedAt]);

  useEffect(() => {
    if (!textareaRef.current) return;
    textareaRef.current.selectionStart = activeDoc.selection.start;
    textareaRef.current.selectionEnd = activeDoc.selection.end;
    textareaRef.current.scrollTop = activeDoc.scrollTop;
  }, [activeDoc.id, activeDoc.selection.end, activeDoc.selection.start, activeDoc.scrollTop]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const meta = event.ctrlKey || event.metaKey;
      if (meta && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandPaletteOpen(true);
      }
      if (meta && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setFindOpen(true);
      }
      if (meta && event.key.toLowerCase() === "z") {
        event.preventDefault();
        undo(activeDoc.id);
      }
      if (meta && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo(activeDoc.id);
      }
      if (event.key === "Escape") {
        setGhostText("");
      }
      if (event.key === "Tab" && ghostText) {
        event.preventDefault();
        const start = activeDoc.selection.start;
        const end = activeDoc.selection.end;
        const content = activeDoc.content.slice(0, start) + ghostText + activeDoc.content.slice(end);
        updateContent(activeDoc.id, content, activeDoc.content, activeDoc.selection);
        const nextPos = start + ghostText.length;
        const nextSel = { start: nextPos, end: nextPos };
        updateSelection(activeDoc.id, nextSel);
        setGhostText("");
        incrementAccepted();
      }
      if (findOpen && event.key === "Enter" && matches.length > 0) {
        event.preventDefault();
        const next = (matchIndex + 1) % matches.length;
        setMatchIndex(next);
        const range = matches[next];
        updateSelection(activeDoc.id, { start: range.start, end: range.end });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    activeDoc,
    findOpen,
    ghostText,
    incrementAccepted,
    matchIndex,
    matches,
    redo,
    setCommandPaletteOpen,
    setFindOpen,
    undo,
    updateContent,
    updateSelection,
  ]);

  useEffect(() => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
    }

    timerRef.current = window.setTimeout(async () => {
      const isTyping = Date.now() - lastTypedAtRef.current < TYPING_COOLDOWN_MS;
      if (isTyping) {
        return;
      }
      if (ghostTextRef.current) {
        return;
      }
      if (requestRunningRef.current) {
        return;
      }
      const now = Date.now();
      if (now < nextAllowedRequestAtRef.current) {
        return;
      }
      if (now - lastRequestAtRef.current < AI_MIN_INTERVAL_MS) {
        return;
      }

      const beforeCursor = activeDoc.content.slice(
        Math.max(0, activeDoc.selection.start - AI_CONTEXT_CHARS),
        activeDoc.selection.start,
      );
      if (beforeCursor.trim().length < 6) {
        return;
      }

      setIsStreaming(true);
      const controller = new AbortController();
      abortRef.current = controller;
      requestRunningRef.current = true;
      lastRequestAtRef.current = Date.now();
      setGhostText("");
      try {
        await streamGeminiSuggestion(beforeCursor, controller.signal, (token) => {
          setGhostText((existing) => existing + token);
        });
      } catch (error) {
        if (error instanceof Error && error.message.includes("429")) {
          nextAllowedRequestAtRef.current = Date.now() + AI_RATE_LIMIT_COOLDOWN_MS;
        }
        // Ignore cancellation/network errors.
      } finally {
        requestRunningRef.current = false;
        setIsStreaming(false);
      }
    }, AI_DEBOUNCE_MS);

    return () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, [activeDoc.content, activeDoc.selection.start, activeDoc.id]);

  const format = (prefix: string, suffix = prefix) => {
    const start = activeDoc.selection.start;
    const end = activeDoc.selection.end;
    const selected = activeDoc.content.slice(start, end);
    const inserted = `${prefix}${selected || "text"}${suffix}`;
    const updated = activeDoc.content.slice(0, start) + inserted + activeDoc.content.slice(end);
    updateContent(activeDoc.id, updated, activeDoc.content, activeDoc.selection);
    const anchor = start + prefix.length;
    updateSelection(activeDoc.id, { start: anchor, end: anchor + (selected || "text").length });
  };

  const onEditorChange = (value: string, selection: EditorSelection) => {
    lastTypedAtRef.current = Date.now();
    abortRef.current?.abort();
    requestRunningRef.current = false;

    if (ghostText) {
      const oldPrefix = ghostText.slice(0, 1);
      const typed = value.charAt(selection.start - 1);
      if (typed && typed === oldPrefix) {
        setGhostText(ghostText.slice(1));
      } else {
        setGhostText("");
        incrementDismissed();
      }
    }
    updateContent(activeDoc.id, value, activeDoc.content, activeDoc.selection);
    updateSelection(activeDoc.id, selection);
  };

  return (
    <div className="studio">
      <header className="tabs">
        {docs.map((doc, index) => (
          <button
            key={doc.id}
            className={`tab ${doc.id === activeDocId ? "active" : ""}`}
            onClick={() => switchDoc(doc.id)}
            draggable
            onDragStart={() => {
              dragDocId.current = doc.id;
            }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => {
              const from = docs.findIndex((item) => item.id === dragDocId.current);
              reorderDocs(from, index);
            }}
          >
            <input value={doc.title} onChange={(event) => renameDoc(doc.id, event.target.value)} />
            {doc.isDirty && <span className="dirty-dot" />}
            <span className="close" onClick={(event) => { event.stopPropagation(); closeDoc(doc.id); }}>x</span>
          </button>
        ))}
        <button className="icon-btn" onClick={createDoc} aria-label="New tab">+</button>
      </header>

      <div className="toolbar">
        <button onClick={() => format("**")}>Bold</button>
        <button onClick={() => format("*")}>Italic</button>
        <button onClick={() => format("# ", "")}>H1</button>
        <button onClick={() => format("## ", "")}>H2</button>
        <button onClick={() => format("`")}>Code</button>
        <button onClick={() => format("> ", "")}>Quote</button>
        <button onClick={() => format("[", "](https://)")}>Link</button>
        <button onClick={() => setWrapEnabled((value) => !value)}>Wrap</button>
        <button onClick={() => setShowLines((value) => !value)}>Line #</button>
        <button onClick={() => setPreviewVisible(!previewVisible)}>Preview</button>
      </div>
      {findOpen && (
        <div className="find-panel">
          <input value={findTerm} onChange={(event) => setFindTerm(event.target.value)} placeholder="Find..." />
          <input value={replaceTerm} onChange={(event) => setReplaceTerm(event.target.value)} placeholder="Replace..." />
          <button
            onClick={() => {
              if (!findTerm) return;
              onEditorChange(activeDoc.content.replaceAll(findTerm, replaceTerm), activeDoc.selection);
            }}
          >
            Replace all
          </button>
          <button onClick={() => setFindOpen(false)}>Close</button>
          <span>{matches.length} matches</span>
        </div>
      )}

      <div className="pane-wrap">
        <section className="editor-pane" style={{ width: previewVisible ? `${splitRatio}%` : "100%" }}>
          <div className="editor-shell">
            {showLines && (
              <div className="lines" aria-hidden>
                {Array.from({ length: lineCount }, (_, index) => (
                  <div key={index}>{index + 1}</div>
                ))}
              </div>
            )}
            <div className="editor-stack">
              <pre className="syntax-layer" aria-hidden dangerouslySetInnerHTML={{ __html: highlightMarkdown(activeDoc.content || " ") }} />
              {ghostText && activeDoc.selection.start === activeDoc.selection.end && (
                <pre className="ghost-inline-layer" aria-hidden>
                  <span className="ghost-hidden-text">{activeDoc.content.slice(0, activeDoc.selection.start)}</span>
                  <span className="ghost-inline">{ghostText}</span>
                </pre>
              )}
              <textarea
                ref={textareaRef}
                aria-label="Writing editor"
                spellCheck={false}
                value={activeDoc.content}
                wrap={wrapEnabled ? "soft" : "off"}
                onScroll={(event) => {
                  const target = event.target as HTMLTextAreaElement;
                  updateScroll(activeDoc.id, target.scrollTop);
                  if (previewRef.current) {
                    previewRef.current.scrollTop = target.scrollTop;
                  }
                }}
                onChange={(event) => {
                  const target = event.target;
                  onEditorChange(target.value, { start: target.selectionStart, end: target.selectionEnd });
                }}
                onSelect={(event) => {
                  const target = event.target as HTMLTextAreaElement;
                  updateSelection(activeDoc.id, { start: target.selectionStart, end: target.selectionEnd });
                }}
              />
            </div>
          </div>
        </section>

        {previewVisible && (
          <>
            <div
              className="divider"
              onMouseDown={(event) => {
                const startX = event.clientX;
                const startRatio = splitRatio;
                const onMove = (moveEvent: MouseEvent) => {
                  const delta = ((moveEvent.clientX - startX) / window.innerWidth) * 100;
                  setSplitRatio(Math.min(80, Math.max(20, startRatio + delta)));
                };
                const onUp = () => {
                  window.removeEventListener("mousemove", onMove);
                  window.removeEventListener("mouseup", onUp);
                };
                window.addEventListener("mousemove", onMove);
                window.addEventListener("mouseup", onUp);
              }}
            />
            <aside
              className="preview-pane"
              ref={previewRef}
              style={{ width: `${100 - splitRatio}%` }}
              onScroll={(event) => {
                if (textareaRef.current) {
                  textareaRef.current.scrollTop = (event.target as HTMLDivElement).scrollTop;
                }
              }}
              dangerouslySetInnerHTML={{ __html: workerHtml }}
            />
          </>
        )}
      </div>

      {commandPaletteOpen && (
        <div className="palette-backdrop" onClick={() => setCommandPaletteOpen(false)}>
          <div className="palette" onClick={(event) => event.stopPropagation()}>
            <input
              autoFocus
              value={paletteQuery}
              onChange={(event) => setPaletteQuery(event.target.value)}
              placeholder="Search actions..."
            />
            <ul>
              {filteredActions.map((action) => (
                <li
                  key={action.id}
                  onClick={() => {
                    action.run();
                    setCommandPaletteOpen(false);
                  }}
                >
                  {action.label}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <footer className="status">
        <span>Ln {activeDoc.content.slice(0, activeDoc.selection.start).split("\n").length}, Col {activeDoc.selection.start - activeDoc.content.lastIndexOf("\n", activeDoc.selection.start - 1)}</span>
        <span>{words} words</span>
        <span>{readingMinutes} min read</span>
        <span>{acceptanceRate}% accepted</span>
        <span>Last save {lastSaveAgo}</span>
        <span>{isStreaming ? "AI typing..." : "Idle"}</span>
      </footer>
    </div>
  );
}
