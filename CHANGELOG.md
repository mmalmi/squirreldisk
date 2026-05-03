# Changelog

## v0.3.9

- Removed the third-party Headway changelog widget and its external script.
- Keeps the Windows scan fix from v0.3.8.

## v0.3.8

- Fixed Windows scans by skipping `pdu` hardlink/shared-output flags that the Windows build cannot support.
- Added regression tests for platform-specific scan helper arguments.

## v0.3.7

- Restored hover preview for directory contents while keeping the sidebar to one directory at a time.
- Kept preview interactions consistent with navigation, drag, and delete behavior.

## v0.3.6

- Kept the sidebar contents anchored to the active directory while preserving hover highlighting.
- Made directory rows navigate even when a scanned directory has no loaded child entries.

## v0.3.5

- Fixed sidebar directory navigation so hovering chart slices no longer swaps the active file list.
- Merged duplicate scan tree entries that resolve to the same displayed directory.
