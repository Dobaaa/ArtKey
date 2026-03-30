export type Theme = "light" | "dark" | "sepia";

export interface EditorSelection {
  start: number;
  end: number;
}

export interface TextSnapshot {
  content: string;
  selection: EditorSelection;
}

export interface DocState {
  id: string;
  title: string;
  content: string;
  selection: EditorSelection;
  scrollTop: number;
  undoStack: TextSnapshot[];
  redoStack: TextSnapshot[];
  isDirty: boolean;
  lastSavedAt: number;
}

export interface WorkerRequest {
  id: string;
  blocks: string[];
}

export interface WorkerResponse {
  id: string;
  html: string;
}
