import { useMemo, useState, type ReactNode } from "react";
import { ChevronRightIcon } from "lucide-react";
import { buildProjectCategoryTree, type ProjectCategoryNode } from "../../projectCategories";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";

export function ProjectCategoryList({
  projects,
  renderProject,
}: {
  projects: readonly SidebarProjectSnapshot[];
  renderProject: (project: SidebarProjectSnapshot) => ReactNode;
}) {
  const tree = useMemo(() => buildProjectCategoryTree(projects), [projects]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  function renderCategory(
    node: ProjectCategoryNode<SidebarProjectSnapshot>,
    depth: number,
  ): ReactNode {
    const expanded = !collapsed.has(node.path);
    return (
      <li key={node.path} className="space-y-0.5">
        <button
          type="button"
          aria-expanded={expanded}
          className="flex h-7 w-full items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          style={{ paddingLeft: depth * 12 + 8 }}
          onClick={() =>
            setCollapsed((previous) => {
              const next = new Set(previous);
              if (next.has(node.path)) next.delete(node.path);
              else next.add(node.path);
              return next;
            })
          }
        >
          <ChevronRightIcon className={`size-3 shrink-0 ${expanded ? "rotate-90" : ""}`} />
          {node.name}
          <span className="ml-auto pr-2 tabular-nums">{node.count}</span>
        </button>
        {expanded && (
          <ul className="space-y-0.5">
            {node.children.map((child) => renderCategory(child, depth + 1))}
            {node.projects.map(renderProject)}
          </ul>
        )}
      </li>
    );
  }
  return (
    <>
      {tree.children.map((node) => renderCategory(node, 0))}
      {tree.projects.map(renderProject)}
    </>
  );
}
