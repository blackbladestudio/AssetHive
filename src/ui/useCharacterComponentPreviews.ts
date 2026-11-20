import { useEffect, useMemo, useRef, useState } from "react";
import type { AssetRecord } from "../types";
import { activeCharacterFiles, componentAssetRecord, characterModelPreviewComponents as listCharacterComponents, needsCharacterComponentPreview, needsCharacterMeshPreview, characterMeshPreviewRevision, characterSuitPendingPreviewViews, characterGroomPendingPreviewViews } from "../../shared/characterComponents.mjs";
import { heroPartKind } from "../../shared/heroPackageRules.mjs";
import { generateCharacterFourViewBlobs, generateCharacterPartFrontBlob, generateCharacterUpdatePreviews } from "./characterPreview";

// One GPU job at a time. Never substitute the parent cover, never render LODs
// over the base mesh, and never overwrite an artist's manually supplied cover.
export function useCharacterComponentPreviews(assets: AssetRecord[], paused: boolean, onUpdated: (asset: AssetRecord) => void) {
  const bridge = window.arkhive;
  const attempted = useRef(new Set<string>());
  const hydrated = useRef(new Set<string>());
  const running = useRef(false);
  const onUpdatedRef = useRef(onUpdated);
  useEffect(() => { onUpdatedRef.current = onUpdated; }, [onUpdated]);
  const [iteration, setIteration] = useState(0);
  const [activeId, setActiveId] = useState("");
  const [activeMeshKind, setActiveMeshKind] = useState('');
  const [activeOwnerId, setActiveOwnerId] = useState("");
  const [progress, setProgress] = useState({ done: 0, total: 0, message: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Refresh character metadata once per owner per window: a restored cover
  // must not remain hidden behind the startup SQLite list snapshot.
  useEffect(() => {
    if (paused || !bridge?.getAssetById) return;
    const owners = assets.filter(asset => asset.source === "custom" && ["monster", "suit", "npc", "weapon", "item"].includes(asset.assetType));
    for (const owner of owners.filter(item => !hydrated.current.has(`${item.path}|${item.id}`)).slice(0, 2)) {
      const key = `${owner.path}|${owner.id}`;
      hydrated.current.add(key);
      void bridge.getAssetById(owner.id).then(result => {
        if (result.ok && result.asset?.path === owner.path) onUpdatedRef.current(result.asset);
      }).catch(() => {}).finally(() => setIteration(value => value + 1));
    }
  }, [assets, bridge, paused, iteration]);
  const partJobs = useMemo(() => assets.filter(asset => asset.source === "custom" && ["monster", "suit", "npc", "weapon", "item"].includes(asset.assetType))
    .filter(owner => !['suit', 'monster', 'npc', 'weapon', 'item'].includes(owner.assetType)).flatMap(owner => listCharacterComponents(owner).filter(needsCharacterComponentPreview).map(part => ({
      kind: "part" as const, owner, part, key: `${owner.path}|${part.id}|${part.currentRevision}|${part.previewUri}`
    }))), [assets]);
  const suitJobs = useMemo(() => assets.filter(owner => owner.source === 'custom' && ['suit', 'monster', 'npc', 'weapon', 'item'].includes(owner.assetType) && !owner.meta?.componentView)
    .map(owner => {
      const parts = listCharacterComponents(owner);
      const pending = characterSuitPendingPreviewViews(owner);
      const changes = parts.flatMap(part => (['staticMesh', 'skeletalMesh'] as const).filter(kind => needsCharacterMeshPreview(part, kind))
        .map(kind => [part.slot, kind, characterMeshPreviewRevision(part.files, kind)]));
      return { kind: 'suit' as const, owner, pending, changes,
        key: JSON.stringify([owner.path, owner.id, changes, pending, pending.length ? (owner.meta.characterComponents as { contentRevision?: string })?.contentRevision : null]) };
    }).filter(job => job.pending.length || job.changes.length), [assets]);
  const ownerJobs = useMemo(() => assets.filter(asset => asset.source === "custom" && (asset.assetType !== "suit" || Boolean((asset.meta.character as { variant?: string })?.variant)) && ["suit", "monster", "npc", "weapon", "item"].includes(asset.assetType) && !asset.meta?.componentView)
    .filter(owner => characterGroomPendingPreviewViews(owner).length > 0 || Array.isArray((owner.meta?.characterComponents as { autoPreviewPendingViews?: string[] } | undefined)?.autoPreviewPendingViews)
      && ((owner.meta.characterComponents as { autoPreviewPendingViews?: string[] }).autoPreviewPendingViews?.length || 0) > 0)
    .map(owner => {
      const state = (owner.meta.characterComponents || {}) as { contentRevision?: string; autoPreviewPendingViews?: string[] };
      return { kind: "owner" as const, owner, pendingViews: characterGroomPendingPreviewViews(owner).length ? characterGroomPendingPreviewViews(owner) : state.autoPreviewPendingViews || [], expectedRevision: state.contentRevision || "initial",
        key: `${owner.path}|${owner.id}|${state.contentRevision}|${(state.autoPreviewPendingViews || []).join(",")}` };
    }), [assets]);
  const jobs = useMemo(() => [...suitJobs, ...partJobs, ...ownerJobs], [suitJobs, partJobs, ownerJobs]);
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;
  const jobSignature = JSON.stringify(jobs.map(job => job.key));

  useEffect(() => {
    if (paused || running.current || !bridge?.updateCharacter || !bridge.getAssetById || !bridge.materializeDroppedFile) return;
    const job = jobsRef.current.find(candidate => !attempted.current.has(candidate.key));
    if (!job) return;
    let cancelled = false;
    let started = false;
    const timer = window.setTimeout(() => {
      if (running.current) { setIteration(value => value + 1); return; }
      running.current = true;
      started = true;
      attempted.current.add(job.key);
      if (job.kind === "part") setActiveId(job.part.id); else setActiveOwnerId(job.owner.id);
      setActiveMeshKind('');
      void (async () => {
        try {
          const loaded = await bridge.getAssetById!(job.owner.id);
          if (!loaded.ok || !loaded.asset || loaded.asset.path !== job.owner.path) throw new Error("主体已删除或资源库已切换");
          const owner = loaded.asset;
          let result;
          if (job.kind === 'suit') {
            const parts = listCharacterComponents(owner);
            const pendingViews = characterSuitPendingPreviewViews(owner);
            const state = owner.meta.characterComponents as { contentRevision?: string };
            const tasks = parts.flatMap(part => (['staticMesh', 'skeletalMesh'] as const).filter(kind => needsCharacterMeshPreview(part, kind)).map(kind => {
              const card = componentAssetRecord(owner, part);
              const slot = (card.meta.componentView as { meshSlots: Record<string, { modelFiles: string[] }> }).meshSlots[kind];
              const models = slot.modelFiles.filter(file => /\.fbx$/i.test(file) && !/_LOD[1-9]\d*(?=\.[^.]+$)/i.test(file));
              if (models.length !== 1) throw new Error('自动四视图需要一个独立 FBX 主模型');
              return { part, kind, path: models[0] };
            }));
            const total = (tasks.length + (pendingViews.length ? 1 : 0)) * 4;
            if (!total || cancelled) return;
            let done = 0;
            setProgress({ done, total, message: '正在准备模型和贴图…' });
            const saves: Array<{ action: 'updateCharacterPreview' | 'updateCharacterAutoPreviews'; payload: Parameters<NonNullable<typeof bridge.updateCharacter>>[1] }> = [];
            const materialize = async (blobs: Record<string, Blob>) => {
              const images = [];
              for (const view of ['front', 'left', 'right', 'back']) {
                if (cancelled) return [];
                const sourcePath = await bridge.materializeDroppedFile!({ name: 'preview_' + view + '.png', bytes: await blobs[view].arrayBuffer() });
                if (!sourcePath) throw new Error('无法保存模型预览');
                images.push({ view, sourcePath });
              }
              return images;
            };
            for (const kind of ['staticMesh', 'skeletalMesh'] as const) {
              const changed = tasks.filter(task => task.kind === kind);
              const renderOwner = kind === 'staticMesh' && pendingViews.length > 0;
              if (!changed.length && !renderOwner) continue;
              const models = renderOwner ? parts.flatMap(part => part.files.filter(file => ['model', 'staticMesh'].includes(file.role)
                && /\.fbx$/i.test(file.normalizedName) && !/_LOD[1-9]\d*(?=\.[^.]+$)/i.test(file.normalizedName)).map(file => owner.path + '/' + file.storedPath)) : changed.map(task => task.path);
              // Normalize separators so paths from model slots and manifest share one scene.
              const normalize = (path: string) => path.replace(/\\/g, '/');
              const texturePaths = kind === 'skeletalMesh' ? [] : renderOwner ? owner.textureFiles
                : [...new Set(changed.flatMap(task => componentAssetRecord(owner, task.part).textureFiles))];
              const textures = await Promise.all(texturePaths.map(async sourcePath => ({ sourcePath,
                previewPath: bridge.getPreviewThumbnail ? await bridge.getPreviewThumbnail(sourcePath).catch(() => sourcePath) || sourcePath : sourcePath })));
              if (cancelled) return;
              const ownerBlobs = await generateCharacterUpdatePreviews(models.map(normalize), textures, new Set(changed.map(task => normalize(task.path))), renderOwner, kind === 'skeletalMesh',
                async (source, blobs) => {
                  const task = changed.find(task => normalize(task.path) === source)!;
                  saves.push({ action: 'updateCharacterPreview', payload: { assetId: owner.id, slot: task.part.slot,
                    automatic: true, meshKind: kind, expectedRevision: characterMeshPreviewRevision(task.part.files, kind),
                    expectedPreviewUri: task.part.meshPreviews[kind].previewUri, images: await materialize(blobs) } });
                }, () => setProgress({ done: ++done, total, message: '正在生成预览…' }), heroPartKind(owner.meta?.character as { variant?: string } | undefined), owner.assetType === 'weapon');
              if (renderOwner) saves.push({ action: 'updateCharacterAutoPreviews', payload: { assetId: owner.id,
                expectedRevision: state.contentRevision || 'initial', images: await materialize(ownerBlobs) } });
            }
            // Publish only after rendering the shared scene, so intermediate list
            // updates cannot cancel and restart the same render batch.
            if (cancelled || !saves.length) return;
            setProgress({ done, total, message: '正在保存预览…' });
            result = await bridge.updateCharacter!('updateCharacterPreviewBatch', { assetId: owner.id, previewBatch: saves.map(save => save.payload) });
            if (result.previewErrors?.length) {
              if (result.asset) onUpdatedRef.current(result.asset);
              throw new Error(result.previewErrors.join('；'));
            }
            if (!result) return;
          } else if (job.kind === "part") {
            const part = listCharacterComponents(owner).find(item => item.slot === job.part.slot);
            if (!part || !needsCharacterComponentPreview(part) || part.currentRevision !== job.part.currentRevision || cancelled) return;
            const card = componentAssetRecord(owner, part);
            const models = card.modelFiles.filter(file => /\.fbx$/i.test(file) && !/_LOD\d+(?=\.[^.]+$)/i.test(file));
            if (models.length !== 1) throw new Error("自动正面照需要一个独立 FBX 主模型；当前格式请手动上传预览图");
            const textures = await Promise.all(card.textureFiles.map(async sourcePath => ({ sourcePath,
              previewPath: bridge.getPreviewThumbnail ? await bridge.getPreviewThumbnail(sourcePath).catch(() => sourcePath) || sourcePath : sourcePath
            })));
            if (cancelled) return;
            const blob = await generateCharacterPartFrontBlob(models[0], textures, 768, heroPartKind(owner.meta?.character as { variant?: string } | undefined));
            if (cancelled) return;
            const previewPath = await bridge.materializeDroppedFile!({ name: "character_part_front.png", bytes: await blob.arrayBuffer() });
            if (!previewPath) throw new Error("无法保存部件正面照");
            if (cancelled) return;
            result = await bridge.updateCharacter!("updateCharacterPreview", {
              assetId: owner.id, slot: part.slot, expectedRevision: part.currentRevision, previewPath,
              automatic: true, expectedPreviewUri: part.previewUri
            });
          } else {
            const state = owner.meta.characterComponents as { contentRevision?: string; autoPreviewPendingViews?: string[] };
            if ((state.contentRevision || "initial") !== job.expectedRevision || (characterGroomPendingPreviewViews(owner).length ? characterGroomPendingPreviewViews(owner) : state.autoPreviewPendingViews || []).join("|") !== job.pendingViews.join("|") || cancelled) return;
            const groom = characterGroomPendingPreviewViews(owner).length ? activeCharacterFiles(owner).find(file => /\.abc$/i.test(file.storedPath)) : undefined;
            if (groom) {
              if (!bridge.renderGroomPreview) throw new Error("Groom 拍摄接口不可用，请重启测试版");
              setProgress({ done: 0, total: 4, message: "正在拍摄 Groom 四视图…" });
              const paths = await bridge.renderGroomPreview(owner.path + "/" + groom.storedPath);
              if (cancelled) return;
              result = await bridge.updateCharacter!("updateCharacterAutoPreviews", { assetId: owner.id, expectedRevision: job.expectedRevision, images: job.pendingViews.map(view => ({ view, sourcePath: paths[view as keyof typeof paths] })) });
            } else {
            const files = activeCharacterFiles(owner).filter(file => /\.fbx$/i.test(file.normalizedName) && !/_LOD\d+\./i.test(file.normalizedName));
            const primary = files.some(file => ['model', 'staticMesh'].includes(file.role)) ? files.filter(file => ['model', 'staticMesh'].includes(file.role)) : files.filter(file => file.role === 'skeletalMesh');
            const models = primary.map(file => owner.path + '/' + file.storedPath);
            if (!models.length) throw new Error("自动四视图需要 FBX 模型；当前格式请手动上传预览图");
            const textures = await Promise.all(owner.textureFiles.map(async sourcePath => ({ sourcePath,
              previewPath: bridge.getPreviewThumbnail ? await bridge.getPreviewThumbnail(sourcePath).catch(() => sourcePath) || sourcePath : sourcePath
            })));
            const blobs = await generateCharacterFourViewBlobs(models, textures, 1024, false, heroPartKind(owner.meta?.character as { variant?: string } | undefined), owner.assetType === 'weapon');
            const images = [];
            for (const view of job.pendingViews) {
              const blob = blobs[view as keyof typeof blobs];
              if (!blob || cancelled) return;
              const sourcePath = await bridge.materializeDroppedFile!({ name: `character_${view}.png`, bytes: await blob.arrayBuffer() });
              if (!sourcePath) throw new Error(`无法保存 ${view} 自动预览`);
              images.push({ view, sourcePath });
            }
            result = await bridge.updateCharacter!("updateCharacterAutoPreviews", { assetId: owner.id, expectedRevision: job.expectedRevision, images });
            }
          }
          if (!result.ok) throw new Error(result.message || "保存部件正面照失败");
          if (!cancelled && result.asset) onUpdatedRef.current(result.asset);
          if (!cancelled) setErrors(previous => { const next = { ...previous }; delete next[job.kind === "part" ? job.part.id : job.owner.id]; return next; });
        } catch (error) {
          console.warn('Character preview failed', job.owner.id, error);
          if (!cancelled) setErrors(previous => ({ ...previous, [job.kind === "part" ? job.part.id : job.owner.id]: error instanceof Error ? error.message : String(error) }));
        } finally {
          if (cancelled) attempted.current.delete(job.key);
          running.current = false;
          setActiveId("");
          setActiveMeshKind('');
          setActiveOwnerId("");
          setIteration(value => value + 1);
        }
      })();
    }, 350);
    // A refreshed asset list must not abort a batch halfway through its saves.
    // The service checks current content and preview revisions before each write.
    return () => { if (!started) cancelled = true; window.clearTimeout(timer); };
  }, [bridge, jobSignature, paused, iteration]);

  function retry(assetId: string) {
    for (const job of jobs) if ((job.kind === "part" ? job.part.id : job.owner.id) === assetId) attempted.current.delete(job.key);
    setErrors(previous => { const next = { ...previous }; delete next[assetId]; return next; });
    setIteration(value => value + 1);
  }
  return { activeId, activeMeshKind, activeOwnerId, progress, errors, retry };
}
