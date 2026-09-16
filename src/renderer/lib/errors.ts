export function userFacingError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/^Error invoking remote method '[^']+':\s*/, '')
    .replace(/^[A-Za-z_$][\w.$]*Error:\s*/, '')
    .trim();
}
