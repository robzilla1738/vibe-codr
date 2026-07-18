export interface UploadBatchOutcome<T> {
  uploaded: T[];
  errors: string[];
}

export async function uploadBatch<TInput, TOutput>(
  items: TInput[],
  upload: (item: TInput) => Promise<TOutput>,
  fallbackError: (item: TInput) => string,
): Promise<UploadBatchOutcome<TOutput>> {
  const uploaded: TOutput[] = [];
  const errors: string[] = [];
  for (const item of items) {
    try {
      uploaded.push(await upload(item));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : fallbackError(item));
    }
  }
  return { uploaded, errors };
}
