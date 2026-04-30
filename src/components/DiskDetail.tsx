import { useEffect, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import diskIcon from "../assets/harddisk.png";
import { getChart } from "../d3chart";
import * as d3 from "d3";
import prettyBytes from "pretty-bytes";
import {
  buildFullPath,
  diskItemToD3Hierarchy,
  addRestrictedPathsToTree,
  groupChildrenByBasePath,
  itemMap,
} from "../pruneData";
import { FileLine } from "./FileLine";
import { ParentFolder } from "./ParentFolder";
import { DragDropContext, Droppable } from "react-beautiful-dnd";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getChartColor } from "../chartColors";
import { getCachedScan, setCachedScan } from "../scanCache";
import { formatScannedAt } from "../scanTime";
import { removeNodesFromTree } from "../treeMutations";

(window as any).LockDNDEdgeScrolling = () => true;

interface ScanStatus {
  items: number;
  total: number;
  errors: number;
}

interface DeleteFailure {
  id: string;
  name: string;
  path: string;
  message: string;
}

interface DeleteState {
  isDeleting: boolean;
  total: number;
  current: number;
  movedBytes: number;
  failures: Array<DeleteFailure>;
}

const emptyDeleteState: DeleteState = {
  isDeleting: false,
  total: 0,
  current: 0,
  movedBytes: 0,
  failures: [],
};

const normalizeNodePath = (node: D3HierarchyDiskItem) =>
  buildFullPath(node).replace(/\\/g, "/");

const formatElapsed = (seconds: number) => {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);

  if (minutes === 0) {
    return `${remainingSeconds}s`;
  }

  return `${minutes}m ${remainingSeconds.toString().padStart(2, "0")}s`;
};

const formatScanRate = (bytes: number, seconds: number) => {
  if (bytes <= 0 || seconds <= 0) {
    return "0 B/s";
  }

  return `${prettyBytes(bytes / seconds)}/s`;
};

const formatProgressPercent = (percent: number) =>
  `${percent < 10 ? percent.toFixed(1) : percent.toFixed(0)}%`;

const Scanning = () => {
  let {
    state: { disk, used, forceScan },
  } = useLocation() as any;
  const navigate = useNavigate();

  const svgRef = useRef<SVGSVGElement | null>(null);

  // Original Data
  const baseData = useRef<DiskItem | null>(null);
  // D3 Hierarchy Data
  const baseDataD3Hierarchy = useRef<D3HierarchyDiskItem | null>(null);

  // Current Directory
  const [focusedDirectory, setFocusedDirectory] =
    useState<D3HierarchyDiskItem | null>(null);
  const [previewDirectory, setPreviewDirectory] =
    useState<D3HierarchyDiskItem | null>(null);
  // Hovered Item
  const [hoveredItem, setHoveredItem] = useState<DiskItem | null>(null);

  const d3Chart = useRef(null) as any;
  const [view, setView] = useState("loading");
  const [status, setStatus] = useState<ScanStatus>();
  const [restrictedPaths, setRestrictedPaths] = useState<Array<RestrictedPath>>(
    []
  );
  const restrictedPathsRef = useRef<Array<RestrictedPath>>([]);
  const scanStartedAt = useRef(performance.now());
  const scannedAtRef = useRef<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [scannedAt, setScannedAt] = useState<number | null>(null);
  const [deleteState, setDeleteState] =
    useState<DeleteState>(emptyDeleteState);

  const [deleteList, setDeleteList] = useState<Array<D3HierarchyDiskItem>>([]);
  const deleteMap = useRef<Map<string, boolean>>(new Map());
  const updateScannedAt = (value: number | null) => {
    scannedAtRef.current = value;
    setScannedAt(value);
  };
  const hoverListItem = (item: D3HierarchyDiskItem) => {
    setHoveredItem({ ...item.data });
    d3Chart.current?.setHoveredNode(item);
  };
  const clearHoveredItem = () => {
    setHoveredItem(null);
    d3Chart.current?.setHoveredNode(null);
  };
  const addRestrictedPath = (restrictedPath: RestrictedPath) => {
    const normalizedPath = restrictedPath.path.replace(/\\/g, "/");
    if (
      restrictedPathsRef.current.some((entry) => entry.path === normalizedPath)
    ) {
      return;
    }

    const next = [
      ...restrictedPathsRef.current,
      { ...restrictedPath, path: normalizedPath },
    ];
    restrictedPathsRef.current = next;
    setRestrictedPaths(next);
  };

  // Avvio il worker e attendo i dati
  useEffect(() => {
    if (baseData.current) {
      // Skip if already loaded data
      return;
    }
    let cancelled = false;
    let scanStarted = false;
    let timer: number | undefined;
    const unlisteners: Array<ReturnType<typeof listen>> = [];

    const startScan = async () => {
      const cached = forceScan ? null : await getCachedScan(disk);
      if (cancelled) {
        return;
      }

      if (cached) {
        restrictedPathsRef.current = cached.restrictedPaths || [];
        setRestrictedPaths(cached.restrictedPaths || []);
        updateScannedAt(cached.scannedAt || null);
        baseData.current = cached.tree;
        baseDataD3Hierarchy.current = diskItemToD3Hierarchy(cached.tree);
        setView("disk");
        return;
      }

      restrictedPathsRef.current = [];
      setRestrictedPaths([]);
      updateScannedAt(null);
      scanStartedAt.current = performance.now();
      timer = window.setInterval(() => {
        setElapsedSeconds((performance.now() - scanStartedAt.current) / 1000);
      }, 500);

      unlisteners.push(
        listen("scan_status", (event: any) => {
          setStatus(event.payload as ScanStatus);
          setElapsedSeconds((performance.now() - scanStartedAt.current) / 1000);
        })
      );

      unlisteners.push(
        listen("scan_restricted_path", (event: any) => {
          addRestrictedPath(event.payload as RestrictedPath);
        })
      );

      unlisteners.push(
        listen("scan_completed", (event: any) => {
          try {
            const parsed = JSON.parse(event.payload);
            const tree =
              parsed.tree?.name === "(total)"
                ? groupChildrenByBasePath(parsed.tree, disk)
                : parsed.tree;
            const treeWithRestrictedPaths = addRestrictedPathsToTree(
              tree,
              disk,
              restrictedPathsRef.current
            );
            const mapped = itemMap(treeWithRestrictedPaths);
            const nextScannedAt = Date.now();
            updateScannedAt(nextScannedAt);
            setCachedScan({
              path: disk,
              tree: mapped,
              used,
              errors: restrictedPathsRef.current.length,
              restrictedPaths: restrictedPathsRef.current,
              scannedAt: nextScannedAt,
            }).catch(console.error);
            baseData.current = mapped;
            baseDataD3Hierarchy.current = diskItemToD3Hierarchy(mapped as any);
            setView("disk");
          } catch (e) {
            console.error(
              "[scan_completed] JSON.parse failed:",
              e,
              "payload snippet:",
              String(event.payload).slice(0, 200)
            );
          }
        })
      );

      scanStarted = true;
      invoke("start_scanning", { path: disk, ratio: "0.001" });
    };

    startScan().catch(console.error);
    return () => {
      cancelled = true;
      if (timer) {
        window.clearInterval(timer);
      }
      unlisteners.forEach((unlisten) => unlisten.then((f) => f()));
      if (scanStarted) {
        invoke("stop_scanning", { path: disk });
      }
    };
  }, [disk, forceScan, used]);

  // Appena ho i dati
  useEffect(() => {
    if (view == "disk") {
      // Remove old chart
      d3.select(svgRef.current).selectAll("*").remove();

      const rootDir = baseDataD3Hierarchy.current!;
      setFocusedDirectory(rootDir);

      const base = baseDataD3Hierarchy.current!; //getViewNode(baseData.current!);

      d3Chart.current = getChart(base, svgRef.current!, {
        centerHover: (_, p) => {
          // console.log({centerHover: p})
          setHoveredItem({ ...p.data });
          setPreviewDirectory(null);
        },
        arcHover: (_, p) => {
          // console.log({arcHover: p})
          setHoveredItem({ ...p.data });
          setPreviewDirectory(p.children ? p : null);
        },
        arcClicked: (_, p) => {
          setFocusedDirectory(p);
          setPreviewDirectory(null);
          return p;
        },
      });
    }
  }, [view]);
  const expectedTotal = typeof used === "number" && used > 0 ? used : 0;
  const progressPercent =
    status && expectedTotal > 0
      ? Math.min((status.total / expectedTotal) * 100, 99.9)
      : null;
  const scanRate = status ? formatScanRate(status.total, elapsedSeconds) : "0 B/s";
  const scannedAtText = formatScannedAt(scannedAt);
  const listedDirectory = previewDirectory || focusedDirectory;
  const selectedDeleteBytes = deleteList.reduce(
    (sum, node) => sum + (node.data.size || 0),
    0
  );
  const deleteProgressPercent =
    deleteState.total > 0
      ? Math.min((deleteState.current / deleteState.total) * 100, 100)
      : 0;
  const shouldOfferFullDiskAccess =
    window.OS_TYPE === "macos" &&
    ((status?.errors || 0) >= 10 || restrictedPaths.length >= 10);
  const openFullDiskAccessSettings = () => {
    invoke("open_full_disk_access_settings").catch(console.error);
  };
  const moveSelectedToTrash = async () => {
    if (deleteState.isDeleting || deleteList.length === 0) {
      return;
    }

    const selected = [...deleteList];
    const successful: Array<D3HierarchyDiskItem> = [];
    const failures: Array<DeleteFailure> = [];
    let movedBytes = 0;

    setDeleteState({
      ...emptyDeleteState,
      isDeleting: true,
      total: selected.length,
    });

    for (const [index, node] of selected.entries()) {
      const nodePath = normalizeNodePath(node);

      try {
        await invoke("move_to_trash", { path: nodePath });
        successful.push(node);
        movedBytes += node.data.size || 0;
      } catch (error) {
        failures.push({
          id: node.data.id,
          name: node.data.name,
          path: nodePath,
          message: error instanceof Error ? error.message : String(error),
        });
      }

      setDeleteState({
        isDeleting: true,
        total: selected.length,
        current: index + 1,
        movedBytes,
        failures: [...failures],
      });
    }

    if (successful.length > 0) {
      const successfulIds = new Set(successful.map((node) => node.data.id));
      const updatedTree = baseData.current
        ? removeNodesFromTree(baseData.current, successfulIds).node
        : null;

      if (updatedTree) {
        baseData.current = updatedTree;
        baseDataD3Hierarchy.current = diskItemToD3Hierarchy(updatedTree);
      }

      d3Chart.current.deleteNodes(successful);
      clearHoveredItem();
      setPreviewDirectory(null);

      if (baseData.current) {
        try {
          await setCachedScan({
            path: disk,
            tree: baseData.current,
            used: baseData.current.size || Math.max(used - movedBytes, 0),
            errors: restrictedPathsRef.current.length,
            restrictedPaths: restrictedPathsRef.current,
            scannedAt: scannedAtRef.current || undefined,
          });
        } catch (error) {
          console.error(error);
        }
      }
    }

    const failedIds = new Set(failures.map((failure) => failure.id));
    const survivingItems = selected.filter((node) => failedIds.has(node.data.id));
    deleteMap.current.clear();
    survivingItems.forEach((node) => deleteMap.current.set(node.data.id, true));
    setDeleteList(survivingItems);
    setDeleteState({
      isDeleting: false,
      total: selected.length,
      current: selected.length,
      movedBytes,
      failures,
    });
  };
  return (
    <>
      {view == "loading" && status && (
        <div className="flex-1 flex flex-col justify-center items-center justify-items-center">
          <img src={diskIcon} className="w-16 h-16"></img>
          <div className="w-2/3 max-w-xl">
            <div className="mt-5 mb-1 text-base text-center font-medium text-white">
              Scanning {disk}
            </div>
            {progressPercent !== null && (
              <div className="mt-4">
                <div className="mb-1 flex items-center justify-between text-xs text-gray-400">
                  <span>Progress</span>
                  <span>{formatProgressPercent(progressPercent)}</span>
                </div>
                <div className="h-2 w-full rounded-full bg-gray-800">
                  <div
                    className="h-2 rounded-full bg-blue-500 transition-[width] duration-300 ease-out"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
              </div>
            )}
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="rounded-md bg-gray-900/70 px-3 py-2">
                <div className="text-[10px] text-gray-500">
                  Items
                </div>
                <div className="mt-1 text-sm font-medium text-white">
                  {status.items.toLocaleString()}
                </div>
              </div>
              <div className="rounded-md bg-gray-900/70 px-3 py-2">
                <div className="text-[10px] text-gray-500">
                  Allocated
                </div>
                <div className="mt-1 text-sm font-medium text-white">
                  {prettyBytes(status.total)}
                </div>
              </div>
              <div className="rounded-md bg-gray-900/70 px-3 py-2">
                <div className="text-[10px] text-gray-500">
                  Time
                </div>
                <div className="mt-1 text-sm font-medium text-white">
                  {formatElapsed(elapsedSeconds)}
                </div>
              </div>
              <div className="rounded-md bg-gray-900/70 px-3 py-2">
                <div className="text-[10px] text-gray-500">
                  Rate
                </div>
                <div className="mt-1 text-sm font-medium text-white">
                  {scanRate}
                </div>
              </div>
            </div>
            <div className="mt-3 text-center text-xs text-gray-500">
              {status.errors > 0
                ? `${status.errors.toLocaleString()} inaccessible items`
                : "No access errors"}
            </div>
            {shouldOfferFullDiskAccess && (
              <div className="mt-3 text-center">
                <button
                  type="button"
                  onClick={openFullDiskAccessSettings}
                  className="rounded bg-gray-800 px-3 py-1 text-xs font-medium text-gray-200 hover:bg-gray-700"
                >
                  Full Disk Access
                </button>
              </div>
            )}
          </div>
          <button
            onClick={() => navigate("/")}
            className="mt-6 relative inline-flex items-center justify-center p-0.5 mb-2 mr-2 overflow-hidden text-sm font-medium  rounded-lg group bg-gradient-to-br from-purple-600 to-blue-500 group-hover:from-purple-600 group-hover:to-blue-500 hover:text-white text-white focus:ring-4 focus:ring-blue-300 focus:ring-blue-800"
          >
            <span className="relative px-5 py-2.5 transition-all ease-in duration-75  bg-gray-900 rounded-md group-hover:bg-opacity-0">
              Back
            </span>
          </button>
        </div>
      )}
      {view == "disk" && (
        <div className="flex-1 flex">
          <DragDropContext
            onDragEnd={(result) => {
              if (deleteState.isDeleting) {
                return;
              }
              if (result.destination?.droppableId !== "deletelist") {
                return;
              }
              const item = focusedDirectory!.children!.find(
                (i) => i.data.id === result.draggableId,
              );
              setDeleteList((val) => {
                if (!val.find((e) => e.data.id === item!.data.id)) {
                  deleteMap.current.set(item!.data.id, true);

                  return [...val, item!];
                } else {
                  return val;
                }
              });
            }}
          >
            <div className="flex flex-1">
              <div
                className="chartpartition flex-1 flex justify-items-center	items-center"
                onMouseLeave={() => {
                  clearHoveredItem();
                  setPreviewDirectory(null);
                }}
              >
                <svg
                  ref={svgRef}
                  width={"100%"}
                  style={{ maxHeight: "calc(100vh - 40px)" }}
                />
              </div>

              <div className="bg-gray-900 w-1/3 p-2 flex flex-col">
                {focusedDirectory && (
                  <ParentFolder
                    focusedDirectory={focusedDirectory}
                    d3Chart={d3Chart}
                  ></ParentFolder>
                )}
                {scannedAtText && (
                  <div className="mt-1 mb-2 px-2 text-[11px] text-gray-500">
                    {scannedAtText}
                  </div>
                )}
                {restrictedPaths.length > 0 && (
                  <div className="mb-2 flex items-center justify-between rounded-md bg-rose-950/30 px-3 py-2 text-xs text-rose-100">
                    <span>
                      {restrictedPaths.length.toLocaleString()} restricted
                    </span>
                    {shouldOfferFullDiskAccess && (
                      <button
                        type="button"
                        onClick={openFullDiskAccessSettings}
                        className="rounded bg-rose-900/60 px-2 py-1 font-medium hover:bg-rose-800"
                      >
                        Full Disk Access
                      </button>
                    )}
                  </div>
                )}
                <Droppable droppableId="filelist">
                  {(provided) => (
                    <div
                      className="overflow-y-auto"
                      style={{ flex: "1 1 auto", height: 100 }}
                      ref={provided.innerRef}
                      {...provided.droppableProps}
                    >
                      {listedDirectory &&
                        listedDirectory.children &&
                        listedDirectory.children.map((c, index) => (
                          <FileLine
                            key={c.data.id}
                            item={c}
                            hoveredItem={hoveredItem}
                            d3Chart={d3Chart}
                            index={index}
                            deleteMap={deleteMap.current}
                            color={getChartColor(c)}
                            onHover={hoverListItem}
                            onHoverEnd={clearHoveredItem}
                          ></FileLine>
                        ))}

                      {provided.placeholder}
                    </div>
                  )}
                </Droppable>
                <Droppable droppableId="deletelist">
                  {(provided) => (
                    <div
                      className="pt-1 flex-initial"
                      ref={provided.innerRef}
                      {...provided.droppableProps}
                    >
                      <div className="rounded-lg border	border-gray-500	border-dashed p-2 text-gray-500 text-center mb-0">
                        {deleteList.length == 0 && (
                          <>Drop files and folders here to move to Trash</>
                        )}
                        {deleteList.length > 0 && (
                          <div className="text-left">
                            <div className="flex items-center justify-between gap-3 text-xs">
                              <span>
                                {deleteList.length} selected ·{" "}
                                {prettyBytes(selectedDeleteBytes)} allocated
                              </span>
                              <button
                                type="button"
                                className="text-gray-300 underline underline-offset-2 hover:text-white disabled:opacity-40"
                                disabled={deleteState.isDeleting}
                                onClick={() => {
                                  setDeleteList([]);
                                  deleteMap.current.clear();
                                  setDeleteState(emptyDeleteState);
                                }}
                              >
                                Clear
                              </button>
                            </div>
                          </div>
                        )}
                        <div>{provided.placeholder}</div>
                        {deleteState.isDeleting && (
                          <div className="mt-3">
                            <div className="mb-1 flex justify-between text-xs text-gray-400">
                              <span>
                                Moving {deleteState.current} of{" "}
                                {deleteState.total}
                              </span>
                              <span>{prettyBytes(deleteState.movedBytes)}</span>
                            </div>
                            <div className="h-1.5 w-full rounded-full bg-gray-800">
                              <div
                                className="h-1.5 rounded-full bg-red-500 transition-[width] duration-200"
                                style={{ width: `${deleteProgressPercent}%` }}
                              />
                            </div>
                          </div>
                        )}
                        {!deleteState.isDeleting &&
                          deleteState.failures.length > 0 && (
                            <div className="mt-3 rounded bg-rose-950/30 p-2 text-left text-xs text-rose-100">
                              <div className="font-semibold">
                                {deleteState.failures.length} survived
                              </div>
                              {deleteState.failures.slice(0, 3).map((failure) => (
                                <div
                                  key={failure.id}
                                  className="mt-1 truncate text-rose-100/80"
                                  title={`${failure.path}: ${failure.message}`}
                                >
                                  {failure.name}
                                </div>
                              ))}
                            </div>
                          )}
                        {deleteList.length > 0 && (
                          <button
                            onClick={moveSelectedToTrash}
                            type="button"
                            disabled={deleteState.isDeleting}
                            className="text-white w-full mt-3 bg-gradient-to-r from-red-600 via-red-700 to-red-600 hover:bg-gradient-to-br focus:ring-4 focus:ring-red-300 focus:ring-red-800 shadow-sm shadow-red-500/50 shadow-lg shadow-red-800/80 font-medium rounded-lg text-sm px-5 py-2.5 text-center mr-2 mb-2"
                          >
                            {deleteState.isDeleting
                              ? "Moving " +
                                deleteState.current +
                                " of " +
                                deleteState.total
                              : "Move to Trash"}
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </Droppable>
              </div>
            </div>
          </DragDropContext>
        </div>
      )}
    </>
  );
};

export default Scanning;
