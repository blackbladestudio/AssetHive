export type ThreeDCoatMode = "ppp" | "vox" | "retopo";

export type ThreeDCoatConnection = {
  executable: string;
  dataDirectory: string;
  executableExists: boolean;
  dataDirectoryExists: boolean;
  ready: boolean;
  mode: ThreeDCoatMode;
  language: "zh" | "en";
};

export type ThreeDCoatImportInfo = ThreeDCoatConnection & {
  assetId: string;
  assetName: string;
  files: Array<{ path: string; label: string }>;
};

export type ThreeDCoatResult<T> = ({ ok: true } & T) | {
  ok: false;
  code: string;
  message: string;
};

export type ThreeDCoatImportPayload = {
  assetId: string;
  modelFile: string;
  mode: ThreeDCoatMode;
};

export type ThreeDCoatQueuedImport = {
  status: "queued";
  modelFile: string;
  mode: ThreeDCoatMode;
  alreadyRunning: boolean;
};
