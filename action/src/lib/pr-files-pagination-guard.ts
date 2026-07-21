export interface PrFileRef {
  filename: string;
  patch?: string;
}

export interface PaginationGuardResult {
  paginationTruncated: boolean;
  missingPatchFiles: string[];
}

export function checkPaginationGuard(
  files: PrFileRef[],
  maxPrFilesPerPage: number,
): PaginationGuardResult {
  return {
    paginationTruncated: files.length >= maxPrFilesPerPage,
    missingPatchFiles: files.filter((f) => f.patch === undefined).map((f) => f.filename),
  };
}
