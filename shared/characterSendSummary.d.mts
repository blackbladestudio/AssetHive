export function characterSendSummary(rows: { key: string; name: string; kind?: string; partSlot?: string; groupName?: string; status: string; action: string }[], decisions?: Record<string, string>, done?: boolean): {
  total: number; pending: number;
  staticMesh: { count: number; parts: string[] }; skeletalMesh: { count: number; parts: string[] };
  groom: { count: number; parts: string[] };
  textures: { count: number; groupCount: number; groups: string[] };
  materials: { count: number; groups: string[] };
};
