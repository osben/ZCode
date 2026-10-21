import type { VirtualProject } from "@/project-sidebar/contract.js";

/** Key of the fork-only local display preference (color, label override) for a project row. */
export function buildProjectDisplayKey(project: Pick<VirtualProject, "id" | "hostId">): string {
  return `project:${project.hostId}:${project.id}`;
}
