import { describe, expect, it } from "vitest";
import {
  buildProjectCategoryTree,
  flattenProjectCategories,
  groupProjectsByCategory,
} from "./projectCategories";
describe("fork sidebar categories", () => {
  it("keeps project order inside categories, puts ungrouped last, and never drops projects", () => {
    const projects = [
      { id: 1, group: null },
      { id: 2, group: " work / clients " },
      { id: 3, group: "personal" },
      { id: 4, group: "work/clients" },
      { id: 5, group: "///" },
    ];
    const sections = groupProjectsByCategory(projects);
    expect(sections.map((s) => s.label)).toEqual(["personal", "work/clients", ""]);
    expect(sections[1]?.projects.map((p) => p.id)).toEqual([2, 4]);
    expect(
      sections
        .flatMap((s) => s.projects)
        .map((p) => p.id)
        .sort(),
    ).toEqual([1, 2, 3, 4, 5]);
    expect(projects.map((p) => p.id)).toEqual([1, 2, 3, 4, 5]);
  });
  it("keeps parent projects and nested categories separate, with stable paths and counts", () => {
    const projects = [
      { id: 1, group: "work" },
      { id: 2, group: "work/clients" },
      { id: 3, group: "personal/clients" },
      { id: 4, group: "" },
    ];
    const tree = buildProjectCategoryTree(projects);
    const work = tree.children.find((n) => n.path === "work")!;
    expect(work.count).toBe(2);
    expect(work.projects.map((p) => p.id)).toEqual([1]);
    expect(work.children[0]?.path).toBe("work/clients");
    expect(tree.children[0]?.children[0]?.path).toBe("personal/clients");
    expect(flattenProjectCategories(tree).map((p) => p.id)).toEqual([3, 2, 1, 4]);
  });
  it("keeps a category-free sidebar in its original order", () => {
    const projects = [
      { id: 3, group: null },
      { id: 1, group: "" },
    ];
    expect(flattenProjectCategories(buildProjectCategoryTree(projects))).toEqual(projects);
  });
});
