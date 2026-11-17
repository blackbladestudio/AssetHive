import { pinyin } from "pinyin";
import { createSearchTermMatcher, normalizeSearchText, parseSearchTags } from "./assetSearch";
import { sameSearchFields, type SearchDocument } from "./assetSearchDocument";
export type { SearchDocument } from "./assetSearchDocument";

type IndexedDocument = { id: string; fields: string[]; identifiers: string[]; romanized: readonly string[]; initials: readonly string[]; words: string[] };
const EMPTY_TERMS: readonly string[] = [];

// One insertion, deletion, substitution or adjacent transposition of a whole word.
function isSingleTypo(query: string, word: string): boolean {
  if (Math.abs(query.length - word.length) > 1) return false;
  let offset = 0;
  while (offset < query.length && query[offset] === word[offset]) offset++;
  if (offset === query.length || offset === word.length) return true;
  if (query.length > word.length) return query.slice(offset + 1) === word.slice(offset);
  if (query.length < word.length) return query.slice(offset) === word.slice(offset + 1);
  return query.slice(offset + 1) === word.slice(offset + 1)
    || (query[offset] === word[offset + 1] && query[offset + 1] === word[offset]
      && query.slice(offset + 2) === word.slice(offset + 2));
}

export class AssetSearchIndex {
  private documents = new Map<string, IndexedDocument>();
  private cache = new Map<string, string[]>();

  update(upserts: SearchDocument[], removed: string[] = []) {
    for (const id of removed) this.documents.delete(id);
    for (const document of upserts) {
      const fields = [...new Set(document.fields.map(normalizeSearchText))];
      const identifiers = [...new Set([document.id, ...(document.identifiers || [])].map(normalizeSearchText))];
      const previous = this.documents.get(document.id);
      if (previous && sameSearchFields(previous.fields, fields) && sameSearchFields(previous.identifiers, identifiers)) continue;
      const romanized: string[] = [];
      const initials: string[] = [];
      for (const field of fields) {
        for (const [chinese] of field.matchAll(/[\u3400-\u9fff]+/gu)) {
          const words = pinyin(chinese, { style: pinyin.STYLE_NORMAL, heteronym: false }).map(word => word[0]);
          romanized.push(words.join(""));
          initials.push(words.map(word => word[0] || "").join(""));
        }
      }
      const words = [...new Set(fields.flatMap(field => field.match(/[a-z]+/gu) || []))];
      this.documents.set(document.id, { id: document.id, fields, identifiers,
        romanized: romanized.length ? [...new Set(romanized)] : EMPTY_TERMS,
        initials: initials.length ? [...new Set(initials)] : EMPTY_TERMS, words });
    }
    this.cache.clear();
  }

  search(text: string, tags: string[] = []): string[] {
    const terms = [...new Set([...parseSearchTags(text), ...tags.map(normalizeSearchText).filter(Boolean)])];
    const key = JSON.stringify(terms);
    const cached = this.cache.get(key);
    if (cached) return cached;
    let candidates = [...this.documents.values()];
    for (const term of terms) {
      const matchesTerm = createSearchTermMatcher(term);
      let matches = candidates.filter(document => document.fields.some(matchesTerm)
        || document.identifiers.some(id => id.includes(term))
        || document.romanized.some(value => value.includes(term))
        || document.initials.some(value => value.includes(term)));
      // Short words such as Temp must never broaden into unrelated typo matches.
      if (!matches.length && /^[a-z]{5,}$/u.test(term)) {
        matches = candidates.filter(document => document.words.some(word => isSingleTypo(term, word)));
      }
      candidates = matches;
      if (!candidates.length) break;
    }
    const ids = candidates.map(document => document.id);
    if (this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, ids);
    return ids;
  }
}
