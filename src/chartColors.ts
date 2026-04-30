import pSBC from "shade-blend-color";

const chartPalette = [
  "#43f57b",
  "#d84cf6",
  "#ff4faf",
  "#ff4f72",
  "#ffd166",
  "#72f2d2",
  "#5ec8ff",
  "#7c7cff",
  "#ff9f6e",
  "#a3e635",
  "#b085ff",
  "#f43f5e",
];

const smallerItemsColor = "#64748b";

const siblingIndexOf = (node: D3HierarchyDiskItem) => {
  const siblings = node.parent?.children;
  if (!siblings) {
    return 0;
  }

  const index = siblings.findIndex(
    (sibling: D3HierarchyDiskItem) => sibling.data.id === node.data.id,
  );
  return index >= 0 ? index : 0;
};

export const getChartColor = (node: D3HierarchyDiskItem) => {
  if (node.data.name === "Smaller Items") {
    return smallerItemsColor;
  }

  const depthShift = Math.max(0, node.depth - 1) * 2;
  const base =
    chartPalette[(siblingIndexOf(node) + depthShift) % chartPalette.length];
  const shade = Math.max(-0.22, Math.min(0, (node.depth - 1) * -0.04));

  return pSBC(shade, base) || base;
};
