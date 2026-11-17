import { useState } from "react";
import type { CutoutTarget } from "./types";

export function useCutoutState() {
  const [cutoutOpen, setCutoutOpen] = useState(false);
  const [cutoutWorkingPath, setCutoutWorkingPath] = useState("");
  const [cutoutBusy, setCutoutBusy] = useState(false);
  const [cutoutHistory, setCutoutHistory] = useState<string[]>([]);
  const [cutoutBackground, setCutoutBackground] = useState<"checker" | "dark" | "light">("checker");
  const [cutoutShowOriginal, setCutoutShowOriginal] = useState(false);
  const [cutoutTolerance, setCutoutTolerance] = useState(12);
  const [cutoutPickPoint, setCutoutPickPoint] = useState<{ x: number; y: number } | null>(null);
  const [cutoutPickSourcePath, setCutoutPickSourcePath] = useState("");
  const [cutoutTarget, setCutoutTarget] = useState<CutoutTarget>("edit");

  return {
    cutoutOpen, setCutoutOpen,
    cutoutWorkingPath, setCutoutWorkingPath,
    cutoutBusy, setCutoutBusy,
    cutoutHistory, setCutoutHistory,
    cutoutBackground, setCutoutBackground,
    cutoutShowOriginal, setCutoutShowOriginal,
    cutoutTolerance, setCutoutTolerance,
    cutoutPickPoint, setCutoutPickPoint,
    cutoutPickSourcePath, setCutoutPickSourcePath,
    cutoutTarget, setCutoutTarget
  };
}
