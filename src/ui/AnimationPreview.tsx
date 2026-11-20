import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { getPreviewUrl } from "./previewUrl";

type AnimationPreviewProps = {
  filePath: string;
  skeletonPath?: string;
  skeletalMeshPath?: string;
  className?: string;
  emptyLabel: string;
  playLabel: string;
  pauseLabel: string;
  failedLabel: string;
  missingMeshLabel: string;
  onMotionCapture?: (capture: () => Promise<Blob | null>) => Promise<void>;
  captureOnly?: boolean;
  onCaptureFinished?: () => void;
};

function recordCanvasToWebm(canvas: HTMLCanvasElement, durationMs: number, signal: AbortSignal) {
  return new Promise<Blob>((resolve, reject) => {
    signal.throwIfAborted();
    if (typeof canvas.captureStream !== "function" || typeof MediaRecorder === "undefined") {
      reject(new Error("motion preview capture is not supported"));
      return;
    }
    const stream = canvas.captureStream(16);
    const mimeType = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]
      .find((type) => MediaRecorder.isTypeSupported(type));
    if (!mimeType) {
      stream.getTracks().forEach((track) => track.stop());
      reject(new Error("webm recording is not supported"));
      return;
    }
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 700000 });
    const chunks: BlobPart[] = [];
    const stop = () => { if (recorder.state !== "inactive") recorder.stop(); };
    const timer = window.setTimeout(stop, Math.max(700, durationMs));
    const cleanup = () => {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      stream.getTracks().forEach(track => track.stop());
    };
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onerror = () => {
      cleanup();
      reject(new Error("motion preview record failed"));
    };
    recorder.onstop = () => {
      cleanup();
      resolve(new Blob(chunks, { type: "video/webm" }));
    };
    try {
      recorder.start(120);
      signal.addEventListener("abort", stop, { once: true });
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

function loadFbx(filePath: string, signal?: AbortSignal) {
  const url = getPreviewUrl(filePath);
  if (signal) {
    return fetch(url, { signal }).then(async response => {
      if (!response.ok && response.status !== 0) throw new Error(`FBX load failed: ${response.status}`);
      const bytes = await response.arrayBuffer();
      signal.throwIfAborted();
      return new FBXLoader().parse(bytes, THREE.LoaderUtils.extractUrlBase(url));
    });
  }
  return new Promise<THREE.Group>((resolve, reject) => {
    new FBXLoader().load(url, resolve, undefined, reject);
  });
}

function applyFbxDisplayScale(object: THREE.Object3D) {
  // FBX 的 UnitScaleFactor 以厘米计，three.js 只写进 userData，预览时再换成米。
  const unitScaleFactor = Number(object.userData?.unitScaleFactor);
  const scale = (Number.isFinite(unitScaleFactor) && unitScaleFactor > 0 ? unitScaleFactor : 1) / 100;
  object.scale.multiplyScalar(scale);
  object.updateMatrixWorld(true);
}

function countRenderableMeshes(object: THREE.Object3D) {
  let count = 0;
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry) {
      count += 1;
    }
  });
  return count;
}

function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    materials.forEach((material) => material?.dispose?.());
  });
}

function frameObject(camera: THREE.PerspectiveCamera, controls: OrbitControls, object: THREE.Object3D) {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z, 0.35);
  const distance = radius * 2.4;
  camera.position.set(center.x + distance * 0.7, center.y + distance * 0.45, center.z + distance * 0.85);
  camera.near = Math.max(0.01, radius / 80);
  camera.far = Math.max(80, radius * 40);
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
}

export function AnimationPreview({
  filePath,
  skeletonPath = "",
  skeletalMeshPath = "",
  className,
  emptyLabel,
  playLabel,
  pauseLabel,
  failedLabel,
  missingMeshLabel,
  onMotionCapture,
  captureOnly = false,
  onCaptureFinished
}: AnimationPreviewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const playingRef = useRef(true);
  const onMotionCaptureRef = useRef(onMotionCapture);
  onMotionCaptureRef.current = onMotionCapture;
  const onCaptureFinishedRef = useRef(onCaptureFinished);
  onCaptureFinishedRef.current = onCaptureFinished;
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const [playing, setPlaying] = useState(true);
  const [clipName, setClipName] = useState("");
  const [missingMesh, setMissingMesh] = useState(false);

  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);

  useEffect(() => {
    const host = hostRef.current;
    const animationSource = String(filePath || "").trim();
    const meshSource = String(skeletalMeshPath || "").trim();
    const skeletonSource = String(skeletonPath || "").trim();
    if (!host) {
      return;
    }
    if (!animationSource) {
      setStatus("idle");
      setClipName("");
      setMissingMesh(false);
      return;
    }

    let cancelled = false;
    const abort = new AbortController();
    let disposeLoaded: (() => void) | null = null;
    setStatus("loading");
    setPlaying(true);
    playingRef.current = true;
    setClipName("");
    setMissingMesh(false);

    void (async () => {
      try {
        const signal = captureOnly ? abort.signal : undefined;
        const animationObject = await loadFbx(animationSource, signal);
        if (cancelled || !host.isConnected) {
          disposeObject(animationObject);
          return;
        }
        const visualSource = captureOnly && countRenderableMeshes(animationObject) > 0 ? "" : meshSource || skeletonSource;
        let visual: THREE.Group;
        try {
          visual = visualSource ? await loadFbx(visualSource, signal) : animationObject;
        } catch (error) {
          disposeObject(animationObject);
          throw error;
        }
        if (cancelled || !host.isConnected) {
          if (visual !== animationObject) disposeObject(visual);
          disposeObject(animationObject);
          return;
        }
        applyFbxDisplayScale(visual);
        if (visual !== animationObject) {
          applyFbxDisplayScale(animationObject);
        }
        visual.traverse((child) => {
          const mesh = child as THREE.Mesh;
          if (mesh.isMesh) {
            mesh.castShadow = false;
            mesh.receiveShadow = false;
          }
        });

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x1b1b1b);
        scene.add(new THREE.HemisphereLight(0xffffff, 0x2a2a2a, 1.25));
        const key = new THREE.DirectionalLight(0xffffff, 1.35);
        key.position.set(2.4, 4.2, 2.8);
        scene.add(key);
        scene.add(visual);

        const meshCount = countRenderableMeshes(visual);
        const clips = (animationObject.animations || []).length > 0
          ? animationObject.animations
          : (visual.animations || []);
        if (captureOnly && (!meshCount || !clips.length)) {
          if (visual !== animationObject) disposeObject(animationObject);
          disposeObject(visual);
          onCaptureFinishedRef.current?.();
          return;
        }
        const helper = meshCount === 0 ? new THREE.SkeletonHelper(visual) : null;
        if (helper) {
          scene.add(helper);
        }
        setMissingMesh(meshCount === 0);

        const width = Math.max(1, host.clientWidth);
        const height = Math.max(1, host.clientHeight);
        const camera = new THREE.PerspectiveCamera(35, width / height, 0.05, 200);
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
        renderer.setPixelRatio(captureOnly ? 1 : Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(width, height, false);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        host.replaceChildren(renderer.domElement);

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.enablePan = true;
        frameObject(camera, controls, visual);

        const mixer = clips.length > 0 ? new THREE.AnimationMixer(visual) : null;
        if (mixer && clips[0]) {
          mixer.clipAction(clips[0]).reset().play();
          setClipName(String(clips[0].name || "").trim());
        }

        const clock = new THREE.Clock();
        const follow = new THREE.Vector3();
        let frameId = 0;
        let captureAfterFrames = meshCount > 0 && onMotionCaptureRef.current ? 8 : 0;
        const captureDurationMs = Math.min(2000, Math.max(900, ((clips[0]?.duration || 1.2) * 1000)));
        const resize = () => {
          if (!host.isConnected) return;
          const nextWidth = Math.max(1, host.clientWidth);
          const nextHeight = Math.max(1, host.clientHeight);
          camera.aspect = nextWidth / nextHeight;
          camera.updateProjectionMatrix();
          renderer.setSize(nextWidth, nextHeight, false);
        };
        const observer = new ResizeObserver(resize);
        const tick = () => {
          if (cancelled) return;
          const delta = clock.getDelta();
          if (mixer && playingRef.current) {
            mixer.update(delta);
          }
          const box = new THREE.Box3().setFromObject(visual);
          if (!box.isEmpty()) {
            box.getCenter(follow);
            controls.target.lerp(follow, 0.12);
          }
          controls.update();
          renderer.render(scene, camera);
          if (captureAfterFrames > 0) {
            captureAfterFrames -= 1;
            if (captureAfterFrames === 0 && onMotionCaptureRef.current) {
              const notify = onMotionCaptureRef.current;
              void notify(async () => {
                if (cancelled) return null;
                const blob = await recordCanvasToWebm(renderer.domElement, captureDurationMs, abort.signal);
                return !cancelled && blob.size > 0 ? blob : null;
              }).catch(() => void 0).finally(() => {
                if (!cancelled && captureOnly) onCaptureFinishedRef.current?.();
              });
            }
          }
          frameId = window.requestAnimationFrame(tick);
        };

        observer.observe(host);
        frameId = window.requestAnimationFrame(tick);
        setStatus("ready");

        disposeLoaded = () => {
          observer.disconnect();
          window.cancelAnimationFrame(frameId);
          mixer?.stopAllAction();
          mixer?.uncacheRoot(visual);
          controls.dispose();
          renderer.dispose();
          if (captureOnly) renderer.forceContextLoss();
          renderer.domElement.remove();
          helper?.geometry.dispose();
          if (visual !== animationObject) {
            disposeObject(animationObject);
          }
          disposeObject(visual);
        };
      } catch {
        if (!cancelled) {
          setStatus("failed");
          setClipName("");
          setMissingMesh(false);
          if (captureOnly) onCaptureFinishedRef.current?.();
        }
      }
    })();

    return () => {
      cancelled = true;
      abort.abort();
      disposeLoaded?.();
      host.replaceChildren();
    };
  }, [filePath, skeletonPath, skeletalMeshPath, captureOnly]);

  if (captureOnly) return <div className="animation-cover-capture" aria-hidden="true">
    <div ref={hostRef} className="animation-preview-stage" />
  </div>;

  const showCanvas = Boolean(filePath) && status !== "failed";

  return (
    <div className={`animation-preview${className ? ` ${className}` : ""}`}>
      <div ref={hostRef} className="animation-preview-stage" hidden={!showCanvas} />
      {!filePath && emptyLabel ? <div className="animation-preview-empty">{emptyLabel}</div> : null}
      {filePath && status === "loading" && <div className="preview-shimmer" />}
      {filePath && status === "failed" && <div className="animation-preview-empty">{failedLabel}</div>}
      {status === "ready" && missingMesh && (
        <div className="animation-preview-empty animation-preview-missing-mesh">{missingMeshLabel}</div>
      )}
      {status === "ready" && (
        <div className="animation-preview-toolbar">
          <button
            type="button"
            className="animation-preview-toggle"
            onClick={() => setPlaying((prev) => !prev)}
            title={playing ? pauseLabel : playLabel}
            aria-label={playing ? pauseLabel : playLabel}
          >
            {playing ? "❚❚" : "▶"}
          </button>
          {clipName ? <span className="animation-preview-clip">{clipName}</span> : null}
        </div>
      )}
    </div>
  );
}
