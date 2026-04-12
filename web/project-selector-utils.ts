import { getPathBaseName } from "./path-utils";

export interface ProjectSelectorOption {
  project: string | null;
  label: string;
  description: string | null;
  searchText: string;
}

export function buildProjectSelectorOptions(
  projects: string[],
  allLabel: string = "All Projects",
): ProjectSelectorOption[] {
  const normalizedAllLabel = allLabel.trim() || "All Projects";
  return [
    {
      project: null,
      label: normalizedAllLabel,
      description: null,
      searchText: normalizedAllLabel.toLowerCase(),
    },
    ...projects.map((project) => {
      const label = getPathBaseName(project);
      return {
        project,
        label,
        description: label === project ? null : project,
        searchText: `${label}\n${project}`.toLowerCase(),
      };
    }),
  ];
}

export function filterProjectSelectorOptions(
  options: ProjectSelectorOption[],
  rawQuery: string,
): ProjectSelectorOption[] {
  const terms = rawQuery.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  if (terms.length === 0) {
    return options;
  }
  return options.filter((option) =>
    terms.every((term) => option.searchText.includes(term)),
  );
}
