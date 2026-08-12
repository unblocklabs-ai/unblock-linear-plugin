export const MANAGED_MEDIA_REF_PATTERN = "^media://inbound/[^/\\\\?#\\u0000]{1,1024}$";

const managedMediaRef = new RegExp(MANAGED_MEDIA_REF_PATTERN, "u");
const prefix = "media://inbound/";

export function managedMediaId(fileRef: string): string | undefined {
  return managedMediaRef.test(fileRef) ? fileRef.slice(prefix.length) : undefined;
}
