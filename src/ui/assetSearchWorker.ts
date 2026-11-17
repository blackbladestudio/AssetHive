import { AssetSearchIndex, type SearchDocument } from "./assetSearchIndex";

const index = new AssetSearchIndex();
self.onmessage = (event: MessageEvent<{ upserts?: SearchDocument[]; removed?: string[]; requestId?: number; text?: string; tags?: string[] }>) => {
  const message = event.data;
  try {
    if (message.upserts) index.update(message.upserts, message.removed);
    if (message.requestId !== undefined) {
      self.postMessage({ requestId: message.requestId, ids: index.search(message.text || "", message.tags) });
    }
  } catch (error) {
    self.postMessage({ requestId: message.requestId, error: String(error) });
  }
};
