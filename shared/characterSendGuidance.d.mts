export function characterSendGuidance(message?: string, t?: (zh: string, en: string) => string): {
  owner: 'artist' | 'rigger' | 'ta'; title: string; next: string;
};
