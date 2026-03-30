import { create } from "zustand";
import { nanoid } from "nanoid";
import type { DocState, EditorSelection, TextSnapshot, Theme } from "./types";

const STORAGE_KEY = "ai-writer-v1";
const SPLIT_KEY = "ai-writer-split";
const THEME_KEY = "ai-writer-theme";

const defaultSelection: EditorSelection = { start: 0, end: 0 };

const createDoc = (title = "Untitled"): DocState => ({
  id: nanoid(),
  title,
  content: "",
  selection: defaultSelection,
  scrollTop: 0,
  undoStack: [],
  redoStack: [],
  isDirty: false,
  lastSavedAt: Date.now(),
});

interface StudioState {
  docs: DocState[];
  activeDocId: string;
  theme: Theme;
  splitRatio: number;
  previewVisible: boolean;
  commandPaletteOpen: boolean;
  findOpen: boolean;
  acceptanceCount: number;
  dismissCount: number;
  switchDoc: (docId: string) => void;
  createDoc: () => void;
  closeDoc: (docId: string) => void;
  renameDoc: (docId: string, title: string) => void;
  reorderDocs: (from: number, to: number) => void;
  updateSelection: (docId: string, selection: EditorSelection) => void;
  updateScroll: (docId: string, scrollTop: number) => void;
  updateContent: (
    docId: string,
    nextContent: string,
    previousContent: string,
    previousSelection: EditorSelection,
  ) => void;
  undo: (docId: string) => void;
  redo: (docId: string) => void;
  markSaved: (docId: string) => void;
  setSplitRatio: (ratio: number) => void;
  setTheme: (theme: Theme) => void;
  setPreviewVisible: (value: boolean) => void;
  setCommandPaletteOpen: (value: boolean) => void;
  setFindOpen: (value: boolean) => void;
  incrementAccepted: () => void;
  incrementDismissed: () => void;
}

function moveItem<T>(items: T[], from: number, to: number): T[] {
  const copy = [...items];
  const [item] = copy.splice(from, 1);
  copy.splice(to, 0, item);
  return copy;
}

function nextUndoStack(undoStack: TextSnapshot[], item: TextSnapshot): TextSnapshot[] {
  return [...undoStack.slice(-149), item];
}

function loadInitialState() {
  const fallbackDocs = [createDoc("Document 1")];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const docs = raw ? (JSON.parse(raw) as DocState[]) : fallbackDocs;
    const validDocs = docs.length > 0 ? docs : fallbackDocs;
    const splitRatio = Number(localStorage.getItem(SPLIT_KEY) ?? "55");
    const theme = (localStorage.getItem(THEME_KEY) as Theme) ?? "light";
    return {
      docs: validDocs,
      activeDocId: validDocs[0].id,
      splitRatio: Number.isFinite(splitRatio) ? splitRatio : 55,
      theme: ["light", "dark", "sepia"].includes(theme) ? theme : "light",
    };
  } catch {
    return {
      docs: fallbackDocs,
      activeDocId: fallbackDocs[0].id,
      splitRatio: 55,
      theme: "light" as Theme,
    };
  }
}

const initial = loadInitialState();

export const useStudioStore = create<StudioState>((set) => ({
  docs: initial.docs,
  activeDocId: initial.activeDocId,
  theme: initial.theme,
  splitRatio: initial.splitRatio,
  previewVisible: true,
  commandPaletteOpen: false,
  findOpen: false,
  acceptanceCount: 0,
  dismissCount: 0,
  switchDoc: (docId) => set({ activeDocId: docId }),
  createDoc: () =>
    set((state) => {
      const doc = createDoc(`Document ${state.docs.length + 1}`);
      return { docs: [...state.docs, doc], activeDocId: doc.id };
    }),
  closeDoc: (docId) =>
    set((state) => {
      const docs = state.docs.filter((doc) => doc.id !== docId);
      if (docs.length === 0) {
        const fresh = createDoc("Document 1");
        return { docs: [fresh], activeDocId: fresh.id };
      }
      const activeDocId = state.activeDocId === docId ? docs[0].id : state.activeDocId;
      return { docs, activeDocId };
    }),
  renameDoc: (docId, title) =>
    set((state) => ({
      docs: state.docs.map((doc) => (doc.id === docId ? { ...doc, title } : doc)),
    })),
  reorderDocs: (from, to) => set((state) => ({ docs: moveItem(state.docs, from, to) })),
  updateSelection: (docId, selection) =>
    set((state) => ({
      docs: state.docs.map((doc) => (doc.id === docId ? { ...doc, selection } : doc)),
    })),
  updateScroll: (docId, scrollTop) =>
    set((state) => ({
      docs: state.docs.map((doc) => (doc.id === docId ? { ...doc, scrollTop } : doc)),
    })),
  updateContent: (docId, nextContent, previousContent, previousSelection) =>
    set((state) => ({
      docs: state.docs.map((doc) =>
        doc.id === docId
          ? {
            ...doc,
            content: nextContent,
            isDirty: true,
            undoStack: nextUndoStack(doc.undoStack, {
              content: previousContent,
              selection: previousSelection,
            }),
            redoStack: [],
          }
          : doc,
      ),
    })),
  undo: (docId) =>
    set((state) => ({
      docs: state.docs.map((doc) => {
        if (doc.id !== docId || doc.undoStack.length === 0) {
          return doc;
        }
        const previous = doc.undoStack[doc.undoStack.length - 1];
        return {
          ...doc,
          content: previous.content,
          selection: previous.selection,
          isDirty: true,
          undoStack: doc.undoStack.slice(0, -1),
          redoStack: nextUndoStack(doc.redoStack, {
            content: doc.content,
            selection: doc.selection,
          }),
        };
      }),
    })),
  redo: (docId) =>
    set((state) => ({
      docs: state.docs.map((doc) => {
        if (doc.id !== docId || doc.redoStack.length === 0) {
          return doc;
        }
        const next = doc.redoStack[doc.redoStack.length - 1];
        return {
          ...doc,
          content: next.content,
          selection: next.selection,
          isDirty: true,
          redoStack: doc.redoStack.slice(0, -1),
          undoStack: nextUndoStack(doc.undoStack, {
            content: doc.content,
            selection: doc.selection,
          }),
        };
      }),
    })),
  markSaved: (docId) =>
    set((state) => ({
      docs: state.docs.map((doc) =>
        doc.id === docId ? { ...doc, isDirty: false, lastSavedAt: Date.now() } : doc,
      ),
    })),
  setSplitRatio: (splitRatio) => set({ splitRatio }),
  setTheme: (theme) => set({ theme }),
  setPreviewVisible: (previewVisible) => set({ previewVisible }),
  setCommandPaletteOpen: (commandPaletteOpen) => set({ commandPaletteOpen }),
  setFindOpen: (findOpen) => set({ findOpen }),
  incrementAccepted: () => set((state) => ({ acceptanceCount: state.acceptanceCount + 1 })),
  incrementDismissed: () => set((state) => ({ dismissCount: state.dismissCount + 1 })),
}));

export function persistStudioState(state: StudioState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.docs));
  localStorage.setItem(SPLIT_KEY, String(state.splitRatio));
  localStorage.setItem(THEME_KEY, state.theme);
}
