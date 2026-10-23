// Existing enrollment settings and integration state keep their current format.
export const stateMigrations = [];

export function normalizeCompatibilityConfig({ cfg }) {
  return { config: cfg, changes: [] };
}
