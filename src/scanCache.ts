interface CachedScan {
  fullscan: boolean;
  path: string;
  tree: DiskItem;
  used: number;
}

const scans = new Map<string, CachedScan>();

const cacheKey = (path: string, fullscan: boolean) =>
  `${fullscan ? "full" : "quick"}:${path}`;

export const getCachedScan = (path: string, fullscan: boolean) =>
  scans.get(cacheKey(path, fullscan)) ||
  (!fullscan ? scans.get(cacheKey(path, true)) : undefined);

export const hasCachedScan = (path: string) =>
  scans.has(cacheKey(path, false)) || scans.has(cacheKey(path, true));

export const setCachedScan = (scan: CachedScan) => {
  scans.set(cacheKey(scan.path, scan.fullscan), scan);
};
