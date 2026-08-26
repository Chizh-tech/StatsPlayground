export async function copyThenClear(
  copy: () => Promise<boolean>,
  clear: () => void | Promise<void>,
): Promise<boolean> {
  try {
    if (!await copy()) return false;
    await clear();
    return true;
  } catch {
    return false;
  }
}
