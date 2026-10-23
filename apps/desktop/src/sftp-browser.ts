import type { RemoteEntry } from "./types";

export type SftpSortField = "name" | "modified" | "size";
export interface SftpSort {
  field: SftpSortField;
  descending: boolean;
}

const filenameOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function selectBrowserPaths(
  visiblePaths: readonly string[],
  selected: ReadonlySet<string>,
  anchor: string | null,
  target: string,
  modifiers: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
): { paths: Set<string>; anchor: string } {
  const additive = modifiers.ctrlKey || modifiers.metaKey;
  const start = anchor === null ? -1 : visiblePaths.indexOf(anchor);
  const end = visiblePaths.indexOf(target);
  if (modifiers.shiftKey && start >= 0 && end >= 0) {
    const range = visiblePaths.slice(Math.min(start, end), Math.max(start, end) + 1);
    return { paths: new Set(additive ? [...selected, ...range] : range), anchor: anchor! };
  }
  const paths = new Set(additive ? selected : []);
  if (additive && paths.has(target)) paths.delete(target);
  else paths.add(target);
  return { paths, anchor: target };
}

export function browseRemoteEntries(entries: RemoteEntry[], query: string, showHidden: boolean, sort: SftpSort): RemoteEntry[] {
  const search = query.trim().toLocaleLowerCase();
  return entries
    .filter((entry) => (showHidden || !entry.name.startsWith(".")) && (!search || entry.name.toLocaleLowerCase().includes(search)))
    .sort((left, right) => {
      const directoryOrder = Number(right.fileType === "directory") - Number(left.fileType === "directory");
      if (directoryOrder) return directoryOrder;
      const difference = sort.field === "size" ? left.size - right.size
        : sort.field === "modified" ? (left.modifiedAtUnix ?? 0) - (right.modifiedAtUnix ?? 0)
          : filenameOrder.compare(left.name, right.name);
      return (sort.descending ? -difference : difference) || filenameOrder.compare(left.name, right.name);
    });
}

export function remoteBreadcrumbs(path: string): { label: string; path: string }[] {
  if (!path.startsWith("/")) return [{ label: path, path }];
  const crumbs = [{ label: "/", path: "/" }];
  let current = "";
  for (const part of path.split("/").filter(Boolean)) {
    current += `/${part}`;
    crumbs.push({ label: part, path: current });
  }
  return crumbs;
}
