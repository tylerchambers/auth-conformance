/** Locale-independent UTF-16 code-unit ordering for stable artifacts and execution. */
export function compareStableText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}
