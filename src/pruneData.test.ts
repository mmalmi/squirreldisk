import { describe, expect, it } from "vitest";

import {
  addRestrictedPathsToTree,
  groupChildrenByBasePath,
  itemMap,
} from "./pruneData";

describe("scan tree path shaping", () => {
  it("groups absolute pdu children under the selected base without double slashes", () => {
    const grouped = groupChildrenByBasePath(
      {
        name: "(total)",
        size: 30,
        value: 30,
        isDirectory: true,
        children: [
          {
            name: "/Users/sirius/Library",
            size: 20,
            value: 20,
            isDirectory: true,
            children: [],
          },
          {
            name: "/Users/sirius/Downloads/file.zip",
            size: 10,
            value: 10,
            isDirectory: false,
            children: [],
          },
        ],
      },
      "/Users/sirius"
    );

    const mapped = itemMap(grouped);

    expect(mapped.id).toBe("/Users/sirius");
    expect(mapped.children.map((child: DiskItem) => child.id)).toEqual([
      "/Users/sirius/Library",
      "/Users/sirius/Downloads",
    ]);
    expect(mapped.children[1].children[0].id).toBe(
      "/Users/sirius/Downloads/file.zip"
    );
    expect(JSON.stringify(mapped)).not.toContain("//Library");
    expect(JSON.stringify(mapped)).not.toContain("//Downloads");
  });

  it("adds inaccessible folders inside the scanned tree", () => {
    const root = itemMap({
      name: "/",
      id: "",
      size: 100,
      value: 100,
      isDirectory: true,
      children: [
        {
          name: "Users",
          id: "",
          size: 100,
          value: 100,
          isDirectory: true,
          children: [],
        },
      ],
    });

    const withRestricted = addRestrictedPathsToTree(root, "/", [
      {
        path: "/private/var/db",
        operation: "read_dir",
        message: "Permission denied",
      },
    ]);

    const privateNode = withRestricted.children.find(
      (child: DiskItem) => child.name === "private"
    );
    const dbNode = privateNode?.children[0]?.children[0];

    expect(dbNode).toMatchObject({
      name: "db",
      restricted: true,
      restrictedPath: "/private/var/db",
      restrictedReason: "Permission denied",
    });
  });
});
