// Bundled by test-preview-electron.cjs with actual preview components from App.tsx.
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
async function until(check, message, timeout = 5000) {
  const start = performance.now();
  while (!check()) {
    if (performance.now() - start > timeout) throw new Error(message);
    await delay(20);
  }
}
const root = createRoot(document.getElementById("root"));
const fixtureUrl = getPreviewUrl(fixture);
const normalUrl = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160"><rect width="320" height="160" fill="#58ad86"/></svg>');
const events = [];
const properties = {
  asset: { id: "one", name: "预览测试", previewImage: fixture, assetType: "3d", meta: { previews: { relativeSize: "2x1" } } },
  x: 16, y: 16, width: 400, height: 240,
  isSelected: false, isFavorite: false, exportDisabled: false,
  onSelect: id => events.push(`select:${id}`), onToggle: id => events.push(`toggle:${id}`),
  onToggleFavorite: id => events.push(`favorite:${id}`), onContextMenu: (_, id) => events.push(`context:${id}`),
  onQuickExport: id => events.push(`export:${id}`)
};
const imageReady = () => {
  const image = document.querySelector(".thumb img");
  return image && image.complete && image.naturalWidth > 0 && image.classList.contains("loaded");
};
function renderCard(loader, props = {}) {
  root.render(<StrictMode><section className="asset-grid asset-grid-virtual" style={{ height: 800 }}>
    <AssetCard {...properties} previewLoader={loader} {...props} />
  </section></StrictMode>);
}

window.runPreviewTests = async () => {
  const passed = [];
  const diagnostics = [];
  try {
    if (window.normalBatchOnly) {
      let format = null;
      const changes = [];
      const renderNormal = () => root.render(<div className="asset-form-card texture-section" style={{ margin: 24, width: 800 }}>
        <TextureEntryRow t={zh => zh} entry={{ id: "normal", textureType: "NormalBump", areaId: 2, filePath: "D:\\Textures\\Normal.png" }}
          usedByOthers={new Set()} textureTypeOptions={["Normal", "NormalBump"]}
          normalMapFormat={format} batchNormalMapFormat={true} isPathMissing={() => false}
          onNormalMapFormatChange={value => { format = value; changes.push(value); renderNormal(); }}
          onTextureTypeChange={() => {}} onDrop={() => {}} onPick={() => {}} onRemove={() => {}} />
        <TextureEntryRow t={zh => zh} entry={{ id: "roughness", textureType: "Roughness", areaId: 2, filePath: "D:\\Textures\\Roughness.png" }}
          usedByOthers={new Set()} textureTypeOptions={["Roughness"]} isPathMissing={() => false}
          onNormalMapFormatChange={() => {}} onTextureTypeChange={() => {}} onDrop={() => {}} onPick={() => {}} onRemove={() => {}} />
      </div>);
      renderNormal();
      await until(() => document.querySelector(".normal-format-select .dark-select-trigger"), "batch normal selector did not mount");
      const trigger = () => document.querySelector(".normal-format-select .dark-select-trigger");
      assert(trigger().textContent === "Multiple Value", "mixed normal formats were presented as a single convention");
      trigger().click();
      await until(() => document.querySelectorAll('.normal-format-select [role="option"]').length === 2, "normal format choices did not open");
      const choices = () => [...document.querySelectorAll('.normal-format-select [role="option"]')];
      const assertChoicesVisible = () => {
        for (const option of choices()) {
          const bounds = option.getBoundingClientRect();
          assert(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2) === option,
            `${option.textContent} is covered by the following texture path`);
        }
      };
      assertChoicesVisible();
      assert(choices().every(option => option.getAttribute("aria-selected") === "false"), "mixed normal formats highlighted a convention");
      choices().find(option => option.textContent === "OpenGL").click();
      await until(() => trigger().textContent === "OpenGL", "mixed normal formats could not be unified to OpenGL directly");
      trigger().click();
      await until(() => choices().length === 2, "normal format choices did not reopen");
      assertChoicesVisible();
      choices().find(option => option.textContent === "DX").click();
      await until(() => trigger().textContent === "DX", "normal formats could not switch back to DX");
      assert(changes.join(",") === "opengl,dx", "normal format selection produced duplicate or incorrect changes");
      const bounds = trigger().getBoundingClientRect();
      const browse = document.querySelector(".texture-drop .browse-icon-btn").getBoundingClientRect();
      const input = document.querySelector(".texture-drop .settings-input").getBoundingClientRect();
      assert(bounds.right <= browse.left, "normal format selector overlaps the file picker");
      assert(bounds.left >= input.left && bounds.top >= input.top && bounds.bottom <= input.bottom, "normal format selector is outside the path field");
      passed.push("Mixed batch NormalBump formats can select OpenGL or DX directly without overlapping the file picker");
      passed.push("Both normal format options remain above the following texture path when opened and reopened");
      await delay(200);
      return { ok: true, passed, diagnostics };
    }
    if (window.importThumbnailsOnly) {
      const requests = [];
      const pendingLoader = new PreviewLoader(async source => {
        requests.push(source);
        await delay(30);
        return fixture + ".thumb.png";
      }, 3);
      const renderPending = version => root.render(<div className="import-asset-list" style={{ height: 180, width: 224, overflow: "auto", flex: "none" }}>
        {Array.from({ length: 1000 }, (_, i) => <div key={i} data-pending-row={i} style={{ height: 48, flexShrink: 0 }}>
          <ImportPreviewThumbnail sourcePath={`${fixture}-${version}-${i}`} loader={pendingLoader} fallback={<span>◇</span>} />
        </div>)}
      </div>);
      renderPending("original");
      await until(() => document.querySelector(".import-asset-thumb img.loaded"), "pending thumbnail did not load");
      await delay(180);
      const checkBounded = () => {
        const images = [...document.querySelectorAll(".import-asset-thumb img")];
        assert(images.length > 0 && images.length <= 12, `pending list decoded ${images.length} images`);
        assert(images.every(image => image.src === getPreviewUrl(fixture + ".thumb.png")), "pending list decoded an original instead of its thumbnail");
        assert(images.filter(image => image.complete).every(image => image.naturalWidth <= 512), "pending thumbnail exceeds its resolution limit");
      };
      checkBounded();
      assert(requests.length <= 12, "offscreen pending originals were requested");
      passed.push("1000 pending assets request and decode only visible 512px-or-smaller thumbnails");
      const list = document.querySelector(".import-asset-list");
      list.scrollTop = 500 * 48;
      await until(() => !document.querySelector('[data-pending-row="0"] img') && document.querySelector('[data-pending-row="500"] img.loaded'), "scroll did not release old previews or load the new window");
      checkBounded();
      assert(requests.length <= 24, "scrolling queued the whole pending list");
      for (let version = 0; version < 5; version++) {
        renderPending(`cutout-${version}`);
        await until(() => requests.some(source => source.includes(`cutout-${version}-500`)) && document.querySelector('[data-pending-row="500"] img.loaded'), "batch cutout replacement did not load");
        await delay(100);
        checkBounded();
      }
      passed.push("Scrolling releases offscreen previews; repeated batch cutout replacements keep decoding bounded");
      diagnostics.push(`Thumbnail requests after scrolling and 5 batch replacements: ${requests.length}`);
      return { ok: true, passed, diagnostics };
    }
    const pasted = [];
    const pasteProps = {
      t: zh => zh, previewImagePath: "", busy: false,
      onPick: () => {}, onDrop: () => {}, onRemove: () => {}, isPathMissing: () => false,
      onPasteImage: file => pasted.push(file)
    };
    const renderPasteSlot = props => root.render(<StrictMode>
      <input data-paste-text="true" />
      <PreviewDropSlot {...pasteProps} {...props} />
    </StrictMode>);
    renderPasteSlot();
    await until(() => document.querySelector(".preview-drop-target"), "paste slot did not mount");
    await delay(30);
    const slot = document.querySelector(".preview-drop-target");
    const textInput = document.querySelector("[data-paste-text]");
    const image = new File([new Uint8Array([137, 80, 78, 71])], "image.png", { type: "image/png" });
    const paste = (target, file = image) => {
      const data = new DataTransfer();
      if (file) data.items.add(file);
      else data.setData("text/plain", "ordinary text");
      const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event;
    };
    assert(!paste(document.body).defaultPrevented && pasted.length === 0, "paste outside preview was intercepted");
    slot.focus();
    assert(document.activeElement === slot, "paste slot cannot receive keyboard focus");
    assert(paste(slot).defaultPrevented && pasted.length === 1, "focused image paste did not reach callback exactly once");
    assert(pasted[0].name === "image.png" && (await pasted[0].arrayBuffer()).byteLength === 4, "screenshot bytes were lost");
    assert(!paste(slot, null).defaultPrevented && pasted.length === 1, "text paste replaced preview");
    slot.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
    slot.blur();
    assert(paste(document.body).defaultPrevented && pasted.length === 2, "hovered image paste did not reach callback");
    textInput.focus();
    assert(!paste(textInput).defaultPrevented && pasted.length === 2, "preview stole text-field paste while hovered");
    textInput.blur();
    const copiedFile = new File(["image bytes"], "预览图.jpg", { type: "" });
    assert(paste(document.body, copiedFile).defaultPrevented && pasted.length === 3, "image file without MIME type was ignored");
    slot.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
    assert(!paste(document.body).defaultPrevented && pasted.length === 3, "preview kept intercepting after pointer left");
    passed.push("Preview paste accepts screenshot bytes and image files only while hovered or focused, preserving text-field paste");

    let nativeReads = 0;
    let resolveNative;
    const oldBridge = window.arkhive;
    window.arkhive = { ...oldBridge, readClipboardImage: () => {
      nativeReads++;
      return new Promise(resolve => { resolveNative = resolve; });
    } };
    const keyPaste = target => {
      const event = new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event;
    };
    const nativeImage = { name: "clipboard-preview.png", bytes: new Uint8Array([137, 80, 78, 71]) };
    slot.focus();
    assert(keyPaste(slot).defaultPrevented && nativeReads === 1, "Ctrl+V without a DOM paste did not read native clipboard or prevent duplicate default paste");
    resolveNative(nativeImage);
    await until(() => pasted.length === 4, "native screenshot paste did not reach preview");
    assert(pasted[3].name === nativeImage.name && (await pasted[3].arrayBuffer()).byteLength === 4, "native screenshot bytes were lost");
    keyPaste(slot);
    paste(slot);
    resolveNative(nativeImage);
    await delay(30);
    assert(pasted.length === 5, "DOM paste and native fallback applied the same image twice");
    keyPaste(slot);
    resolveNative(null);
    await delay(30);
    assert(pasted.length === 5, "empty native clipboard replaced preview");
    textInput.focus();
    keyPaste(textInput);
    assert(nativeReads === 3, "native clipboard fallback stole text input paste");
    passed.push("Ctrl+V reads native image bytes without a DOM paste, avoids duplicate application and preserves text input");

    renderPasteSlot({ busy: true });
    await delay(30);
    slot.focus();
    keyPaste(slot);
    assert(!paste(slot).defaultPrevented && pasted.length === 5 && nativeReads === 3, "busy preview accepted paste");
    renderPasteSlot({ onPasteImage: undefined });
    await delay(30);
    keyPaste(slot);
    assert(!paste(slot).defaultPrevented && pasted.length === 5 && nativeReads === 3, "unconfigured preview unexpectedly accepted paste");
    renderPasteSlot();
    await delay(30);
    slot.focus();
    keyPaste(slot);
    assert(nativeReads === 4, "native paste did not start before unmount");
    root.render(<div />);
    await delay(30);
    resolveNative(nativeImage);
    await delay(30);
    keyPaste(document.body);
    assert(!paste(document.body).defaultPrevented && pasted.length === 5 && nativeReads === 4, "unmounted slot retained paste handling or applied a late native read");
    window.arkhive = oldBridge;
    passed.push("Busy, unconfigured and unmounted preview slots do not handle image paste or late clipboard results");

    if (window.previewClipboardOnly) return { ok: true, passed, diagnostics };

    if (LegacyAssetCard) {
      const renderLegacy = previewSrc => root.render(<section className="asset-grid asset-grid-virtual" style={{ height: 800 }}>
        <LegacyAssetCard {...properties} previewSrc={previewSrc} style={{ width: 400, height: 240, transform: "translate3d(16px,16px,0)" }} />
      </section>);
      renderLegacy(normalUrl);
      await delay(600);
      diagnostics.push(`Legacy static load: ${imageReady() ? "loaded" : "not loaded"}`);
      // Force eager only in the diagnostic if Chromium defers a hidden lazy image.
      const initial = document.querySelector(".thumb img");
      if (initial) initial.loading = "eager";
      await until(imageReady, "legacy source did not load");
      renderLegacy(getPreviewUrl(fixture + ".missing-thumb"));
      await until(() => !document.querySelector(".thumb img"), "legacy replacement failure did not reproduce");
      diagnostics.push("Reproduced: failed thumbnail replacement removes a successfully loaded original");
      const broken = new Image();
      broken.src = encodeURI(`file:///${fixture.replace(/\\/g, "/")}`);
      await until(() => broken.complete, "legacy hash filename request did not settle");
      assert(broken.naturalWidth === 0, "legacy hash filename should fail");
      diagnostics.push("Reproduced: legacy file URL cannot load a filename containing #");
    }

    let calls = 0;
    const loader = new PreviewLoader(async path => { calls++; await delay(30); return path; });
    renderCard(loader);
    await until(imageReady, "static preview requires mouse interaction");
    await delay(240);
    assert(getComputedStyle(document.querySelector(".thumb img")).opacity === "1", "loaded image is transparent");
    assert(document.querySelector(".thumb img").src === fixtureUrl, "file URL changed the filename");
    passed.push("Static transformed/contained card loads without mouse input, including Unicode, # and % in filename");

    const card = document.querySelector(".card");
    card.click();
    card.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    document.querySelector(".card-fav-btn").click();
    document.querySelector(".card-export-btn").click();
    card.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    assert(events.join(",") === "select:one,toggle:one,favorite:one,export:one,context:one", "card actions changed: " + events);
    passed.push("Selection, shift selection, favorite, quick export and context menu retain callbacks without button click bubbling");

    root.render(<div />);
    await delay(40);
    renderCard(loader, { isSelected: true, isFavorite: true });
    await until(imageReady, "cached remount did not load");
    assert(calls === 1, "cached remount repeated IPC");
    assert(document.querySelector(".card.active .card-fav-btn.active"), "selected/favorite styles lost");
    passed.push("Cached virtual-card remount loads with no extra thumbnail request");

    root.render(<div />);
    await delay(40);
    let finishThumbnail;
    const thumbnailFirst = new PreviewLoader(() => new Promise(resolve => { finishThumbnail = resolve; }));
    renderCard(thumbnailFirst);
    await until(() => finishThumbnail, "thumbnail request did not start");
    assert(!document.querySelector(".thumb img"), "full-resolution original was loaded before the thumbnail");
    finishThumbnail(fixture + ".thumb.png");
    await until(imageReady, "thumbnail did not load");
    assert(document.querySelector(".thumb img").src === getPreviewUrl(fixture + ".thumb.png"), "thumbnail was not used");
    passed.push("Cold card waits for the small thumbnail instead of decoding the full-resolution original first");

    const failing = new PreviewLoader(async () => fixture + ".missing-thumb");
    renderCard(failing);
    await until(() => failing.get(fixture), "failed-thumbnail request did not resolve");
    await until(() => imageReady() && document.querySelector(".thumb img").src === fixtureUrl, "missing thumbnail did not fall back to original");
    passed.push("Missing cached thumbnail falls back to original without hovering");

    const missing = { ...properties.asset, id: "missing", previewImage: fixture + ".missing-original" };
    renderCard(failing, { asset: missing });
    await until(() => failing.get(missing.previewImage), "missing-original request did not resolve");
    await until(() => !document.querySelector(".thumb img") && !document.querySelector(".card-thumb-shimmer"), "missing original left an endless shimmer");
    passed.push("Missing original terminates with placeholder instead of retry loop");

    // Saving keeps the asset ID while replacing the preview path. Exercise both
    // mounted surfaces together, including a replacement already in image cache.
    const renderSaved = path => root.render(<>
      <section className="asset-grid asset-grid-virtual" style={{ height: 300 }}>
        <AssetCard {...properties} asset={{ ...properties.asset, previewImage: path }} previewLoader={loader} />
      </section>
      <div className="preview-main"><DetailPreview key={path} src={getPreviewUrl(path)} name="Detail"
        fallback={<span data-detail-fallback="true">Missing</span>} /></div>
    </>);
    for (const path of [fixture, fixture + ".thumb.png", fixture]) {
      renderSaved(path);
      await until(() => {
        const detail = document.querySelector(".preview-img");
        const card = document.querySelector(".thumb img");
        return imageReady() && card.src === getPreviewUrl(path) && detail?.src === getPreviewUrl(path)
          && detail.complete && detail.naturalWidth > 0 && detail.classList.contains("loaded")
          && !document.querySelector(".preview-shimmer");
      }, "saved preview did not load in both mounted surfaces");
      await delay(350);
      assert(getComputedStyle(document.querySelector(".preview-img")).opacity === "1", "detail became transparent after loading");
    }
    renderSaved(fixture + ".missing-original");
    await until(() => document.querySelector("[data-detail-fallback]"), "detail error did not settle");
    renderSaved(fixture);
    await until(() => document.querySelector(".preview-img.loaded"), "replacement inherited previous failure");
    passed.push("Same asset preview replacements, cached return and recovery from missing image load without hover or selection changes");

    renderCard(loader, { asset: { ...properties.asset, assetType: "hdri" }, savingProgress: 25 });
    await until(() => document.querySelector(".card.hdri") && imageReady(), "HDRI cover preview did not load");
    assert(getComputedStyle(document.querySelector(".thumb img")).objectFit === "cover", "HDRI cover changed");
    const previousEvents = events.length;
    document.querySelector(".card").click();
    assert(events.length === previousEvents && document.querySelector(".card-export-btn").disabled, "saving guard changed");
    passed.push("HDRI cover and saving interaction guard preserved");

    const scrollLoader = new PreviewLoader(async path => { await delay(20); return path; }, 3);
    const assets = Array.from({ length: 80 }, (_, i) => ({ ...properties.asset, id: String(i), previewImage: fixture }));
    const renderWindow = offset => root.render(<section className="asset-grid asset-grid-virtual" style={{ height: 800 }}>
      {assets.slice(offset, offset + 12).map((asset, i) => <AssetCard key={asset.id} {...properties} asset={asset} previewLoader={scrollLoader}
        x={16 + i % 4 * 280} y={16 + Math.floor(i / 4) * 240} width={260} height={220} />)}
    </section>);
    for (let i = 0; i < 50; i += 5) { renderWindow(i); await delay(10); }
    await until(() => document.querySelectorAll(".thumb img.loaded").length === 12, "rapid virtual scrolling left unloaded images");
    await delay(240);
    passed.push("Rapid virtual unmount/remount settles all 12 cards without mouse input");
    return { ok: true, passed, diagnostics };
  } catch (error) {
    return { ok: false, passed, diagnostics, error: String(error) };
  }
};
