export function isMultiKeyChannel(
  keyMode: string | null | undefined,
  extraKeyCount: number
): boolean {
  return keyMode === "multi" || extraKeyCount > 0;
}

export function normalizeChannelKeyMode(
  keyMode: string | null | undefined,
  extraKeyCount: number
): "single" | "multi" {
  return isMultiKeyChannel(keyMode, extraKeyCount) ? "multi" : "single";
}
