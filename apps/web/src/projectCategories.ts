export interface CategorizedProject {
  readonly group?: string | null;
}
export function categoryPath(group: string | null | undefined): string {
  return (group ?? "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("/");
}
export function groupProjectsByCategory<T extends CategorizedProject>(projects: readonly T[]) {
  const buckets = new Map<string, T[]>();
  for (const project of projects) {
    const label = categoryPath(project.group);
    const bucket = buckets.get(label);
    if (bucket) bucket.push(project);
    else buckets.set(label, [project]);
  }
  return [...buckets]
    .sort(([a], [b]) => (!a ? 1 : !b ? -1 : a.localeCompare(b)))
    .map(([label, members]) => ({ label, projects: members }));
}
export interface ProjectCategoryNode<T> {
  name: string;
  path: string;
  projects: T[];
  children: ProjectCategoryNode<T>[];
  count: number;
}
export function buildProjectCategoryTree<T extends CategorizedProject>(projects: readonly T[]) {
  const root: ProjectCategoryNode<T> = { name: "", path: "", projects: [], children: [], count: 0 };
  for (const section of groupProjectsByCategory(projects)) {
    let node = root;
    node.count += section.projects.length;
    for (const segment of section.label.split("/").filter(Boolean)) {
      let child = node.children.find((item) => item.name === segment);
      if (!child) {
        child = {
          name: segment,
          path: node.path ? node.path + "/" + segment : segment,
          projects: [],
          children: [],
          count: 0,
        };
        node.children.push(child);
      }
      child.count += section.projects.length;
      node = child;
    }
    node.projects.push(...section.projects);
  }
  return root;
}
export function flattenProjectCategories<T>(node: ProjectCategoryNode<T>): T[] {
  return [...node.children.flatMap(flattenProjectCategories), ...node.projects];
}
