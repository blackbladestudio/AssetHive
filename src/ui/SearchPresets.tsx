import { useState } from "react";
import type { SearchState } from "./hooks/types";
import { SEARCH_PRESETS_KEY, readSearchPresets, type SearchPreset } from "./searchPresetsStorage";

export function SearchPresets({ search, menu, english, onApply, onError }: {
  search: SearchState; menu: string; english: boolean; onApply: (search: SearchState, menu: string) => void; onError: (message: string) => void;
}) {
  const [presets, setPresets] = useState(() => {
    try { return readSearchPresets(window.localStorage); }
    catch { return []; }
  });
  const [name, setName] = useState("");
  const persist = (next: SearchPreset[]) => {
    try { window.localStorage.setItem(SEARCH_PRESETS_KEY, JSON.stringify(next)); setPresets(next); }
    catch (error) { onError(String(error)); }
  };
  return <details className="search-presets">
    <summary className="top-action">{english ? "Saved filters" : "常用筛选"}</summary>
    <div className="search-presets-panel">
      {presets.map(preset => <div className="search-preset-row" key={preset.name}>
        <button type="button" onClick={event => {
          onApply(structuredClone(preset.search), preset.menu);
          event.currentTarget.closest("details")?.removeAttribute("open");
        }}>{preset.name}</button>
        <button type="button" aria-label={`${english ? "Delete" : "删除"} ${preset.name}`} onClick={() => persist(presets.filter(item => item.name !== preset.name))}>×</button>
      </div>)}
      {!presets.length && <p>{english ? "Save a filter combination to reuse it." : "保存筛选组合，下次一键使用。"}</p>}
      <form onSubmit={event => {
        event.preventDefault();
        const label = name.trim();
        if (!label) return;
        persist([{ name: label, menu, search: structuredClone(search) }, ...presets.filter(item => item.name !== label)].slice(0, 20));
        setName("");
      }}>
        <input value={name} maxLength={40} onChange={event => setName(event.target.value)} placeholder={english ? "Filter name" : "筛选名称"} aria-label={english ? "Filter name" : "筛选名称"} />
        <button type="submit" disabled={!name.trim()}>{english ? "Save current" : "保存当前筛选"}</button>
      </form>
    </div>
  </details>;
}
