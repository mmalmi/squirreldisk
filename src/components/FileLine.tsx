import prettyBytes from "pretty-bytes";
import { buildFullPath } from "../pruneData";
import { getIconForFile, getIconForFolder } from "vscode-icons-js";
// import { iconImages } from "./iconImages";
import { Draggable } from "react-beautiful-dnd";
import { invoke } from "@tauri-apps/api/core";

interface FileLineProps {
  item: D3HierarchyDiskItem;
  hoveredItem: DiskItem | null;
  d3Chart: any;
  index: number;
  deleteMap: Map<string, boolean>;
  color: string;
  onHover: (item: D3HierarchyDiskItem) => void;
  onHoverEnd: () => void;
}

const mul = window.OS_TYPE === "windows" ? 1024 : 1000;
export const FileLine = ({
  item,
  hoveredItem,
  d3Chart,
  index,
  deleteMap,
  color,
  onHover,
  onHoverEnd,
}: FileLineProps) => {
  const isRestricted = !!item.data.restricted;
  return (
    <Draggable
      draggableId={item.data.id}
      index={index}
      isDragDisabled={isRestricted}
    >
      {(provided) => (
        <div
          className={
            "bg-gray-900 p-2 text-white flex justify-between rounded-md mt-1 pl-4 cursor-pointer hover:bg-black/20 " +
            (hoveredItem && item.data && hoveredItem.id === item.data.id
              ? "bg-black/20"
              : " ") +
            (isRestricted ? "text-rose-100/80 " : " ") +
            (deleteMap.has(item.data.id)
              ? "border border-red-800 hover:border-red-900"
              : " ")
          }
          onContextMenu={(e) => {
            e.preventDefault();
            invoke("show_in_folder", { path: buildFullPath(item) });
          }}
          onClick={() => {
            isRestricted
              ? invoke("show_in_folder", { path: buildFullPath(item) })
              : item.children
              ? d3Chart.current.focusDirectory(
                  item,
                ) /*window.electron.diskUtils.showItemInFolder(buildFullPath(c))*/
              : invoke("show_in_folder", { path: buildFullPath(item) });
          }}
          onMouseEnter={() => onHover(item)}
          onMouseLeave={onHoverEnd}
          title={
            isRestricted
              ? item.data.restrictedPath || item.data.restrictedReason
              : undefined
          }
          {...provided.draggableProps}
          {...provided.dragHandleProps}
          ref={provided.innerRef}
        >
          <div
            className="h-3 w-3 shrink-0 rounded-full mr-3 self-center"
            style={{ backgroundColor: isRestricted ? "#e11d48" : color }}
          />
          {isRestricted ? (
            <svg
              className="h-4 w-4 shrink-0 mr-3 text-rose-500"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
            >
              <circle
                cx="8"
                cy="8"
                r="6"
                stroke="currentColor"
                strokeWidth="2"
              />
              <path
                d="M4.5 11.5l7-7"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          ) : (
            <img
              className="h-4 w-4 shrink-0 mr-3"
              src={
                item.data.isDirectory
                  ? "/fileicons/" + getIconForFolder(item.data.name)
                  : "/fileicons/" +
                    (getIconForFile(item.data.name) || "default_file.svg")
              }
            />
          )}
          <div className="truncate basis-8/12 flex-1 shrink text-xs">
            {item.data.name}
          </div>
          <div className="flex-1 basis-3/12 text-right text-xs">
            {/* {JSON.stringify(item.data)} */}
            {isRestricted
              ? "Restricted"
              : item &&
              item.data &&
                `${(item.data.size / mul / mul / mul).toFixed(2)} GB`}
          </div>
        </div>
      )}
    </Draggable>
  );
};
