/// <reference lib="webworker" />
import { marked } from "marked";
import type { WorkerRequest, WorkerResponse } from "./types";

const cache = new Map<number, { source: string; html: string }>();

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { id, blocks } = event.data;
  const htmlBlocks = blocks.map((block, index) => {
    const cached = cache.get(index);
    if (cached && cached.source === block) {
      return cached.html;
    }
    const html = marked.parse(block, { breaks: true }) as string;
    cache.set(index, { source: block, html });
    return html;
  });

  const response: WorkerResponse = { id, html: htmlBlocks.join("\n") };
  self.postMessage(response);
};

export { };
