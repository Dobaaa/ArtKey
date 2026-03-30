import { GoogleGenAI } from "@google/genai";

const pendingRequests = new Map<string, Promise<string>>();
const MODEL = "gemini-3-flash-preview";

function makeKey(prompt: string): string {
  return prompt.trim().slice(-200);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function runWithAbort<T>(signal: AbortSignal, task: Promise<T>): Promise<T> {
  if (signal.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  return await Promise.race([
    task,
    new Promise<T>((_, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    }),
  ]);
}

export async function streamGeminiSuggestion(
  prompt: string,
  signal: AbortSignal,
  onToken: (token: string) => void,
): Promise<string> {
  const context = makeKey(prompt);
  if (!context) {
    return "";
  }

  const existing = pendingRequests.get(context);
  if (existing) {
    return existing;
  }

  const key =
    (import.meta.env.VITE_GEMINI_API_KEY as string | undefined) ??
    (import.meta.env.GEMINI_API_KEY as string | undefined);
  if (!key) {
    throw new Error("Missing GEMINI API key");
  }
  const ai = new GoogleGenAI({ apiKey: key });

  const request = (async () => {
    const backoffMs = [2000, 4000];
    for (let attempt = 0; attempt <= backoffMs.length; attempt += 1) {
      try {
        const response = await runWithAbort(
          signal,
          ai.models.generateContent({
            model: MODEL,
            contents: "Continue this text naturally with one or two short sentences only. Do not repeat the existing text.\n" + context,
          }),
        );
        const fullText = (response.text ?? "").trim();
        if (!fullText) {
          return "";
        }

        const pieces = fullText.match(/\S+\s*/g) ?? [fullText];
        for (const piece of pieces) {
          if (signal.aborted) {
            throw new DOMException("Aborted", "AbortError");
          }
          onToken(piece);
          await sleep(22, signal);
        }
        return fullText.trim();
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("429")) {
          throw new Error("Gemini request failed: 429");
        }
        if (attempt < backoffMs.length) {
          await sleep(backoffMs[attempt], signal);
          continue;
        }
        throw (error instanceof Error ? error : new Error("Gemini request failed"));
      }
    }
    throw new Error("Gemini request failed");
  })();

  pendingRequests.set(context, request);
  try {
    return await request;
  } finally {
    pendingRequests.delete(context);
  }
}
