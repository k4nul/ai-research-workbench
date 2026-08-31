export async function uploadMutationFingerprint(
  projectId: string,
  form: FormData
): Promise<string> {
  const file = form.get("file");
  if (!(file instanceof File)) return JSON.stringify({ projectId, file: null });
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  const sha256 = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return JSON.stringify({
    projectId,
    filename: file.name,
    mimeType: file.type,
    byteSize: file.size,
    lastModified: file.lastModified,
    sha256,
    metadata: [...form.entries()]
      .filter(([, value]) => typeof value === "string")
      .map(([key, value]) => [key, value])
  });
}
