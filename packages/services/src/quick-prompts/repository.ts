import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  findQuickPromptGlobalBlockers,
  normalizeQuickPromptColor,
  QUICK_PROMPT_LIST_LIMIT,
  type QuickPrompt,
  type QuickPromptBody,
  type QuickPromptCreateInput,
  type QuickPromptProjectRef,
  type QuickPromptScope,
  type QuickPromptSnapshot,
  type QuickPromptUpdateInput,
} from "#src/quick-prompts/contract.js";

const COLUMNS =
  "prompt_id, scope, host_id, project_id, name, body_markdown, body_nodes, color, pinned, position, created_at, updated_at";

interface PromptRow {
  prompt_id: string;
  scope: string;
  host_id: string | null;
  project_id: string | null;
  name: string;
  body_markdown: string;
  body_nodes: string;
  /** Raw column value; normalized only when building a QuickPrompt (spec: a newer build's hue must survive edits). */
  color: unknown;
  pinned: number;
  position: number;
  created_at: number;
  updated_at: number;
}

interface Target {
  scope: QuickPromptScope;
  project: QuickPromptProjectRef | null;
}

function toPrompt(row: PromptRow): QuickPrompt {
  return {
    promptId: row.prompt_id,
    scope: row.scope as QuickPromptScope,
    project:
      row.scope === "global"
        ? null
        : { hostId: row.host_id ?? "", projectId: row.project_id ?? "" },
    name: row.name,
    body: { markdown: row.body_markdown, nodes: row.body_nodes },
    color: normalizeQuickPromptColor(row.color),
    pinned: row.pinned === 1,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sameProject(a: QuickPromptProjectRef | null, b: QuickPromptProjectRef | null): boolean {
  if (a === null || b === null) return a === b;
  return a.hostId === b.hostId && a.projectId === b.projectId;
}

function assertTarget(target: Target): void {
  if ((target.scope === "global") !== (target.project === null)) {
    throw new Error("quick-prompt.scope-mismatch");
  }
}

function assertGlobalBody(scope: QuickPromptScope, body: QuickPromptBody): void {
  if (scope === "global" && findQuickPromptGlobalBlockers(body.nodes).length > 0) {
    throw new Error("quick-prompt.global-mention-blocked");
  }
}

/**
 * Quick prompt SQL. Every method that reads a list position, counts a list or compares members runs inside
 * the same BEGIN IMMEDIATE transaction as its write, so two Host processes cannot both pass the limit.
 * Methods never open a transaction inside another one (the shared tasks-index handle may already be busy).
 */
export class QuickPromptRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {}

  private write<T>(run: () => T): T {
    if (this.db.isTransaction) throw new Error("quick-prompts.nested-transaction");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  read(project: QuickPromptProjectRef | null): QuickPromptSnapshot {
    const own = !this.db.isTransaction;
    if (own) this.db.exec("BEGIN");
    try {
      const hidden = new Set<string>();
      if (project) {
        for (const row of this.db
          .prepare(
            "SELECT prompt_id FROM fork_quick_prompt_hidden WHERE host_id=? AND project_id=?",
          )
          .all(project.hostId, project.projectId)) {
          hidden.add(String(row.prompt_id));
        }
      }
      const globals = (
        this.db
          .prepare(
            `SELECT ${COLUMNS} FROM fork_quick_prompts WHERE scope='global' ORDER BY position, prompt_id`,
          )
          .all() as unknown as PromptRow[]
      ).map((row) => ({
        ...toPrompt(row),
        hiddenInProject: hidden.has(row.prompt_id),
      }));
      const projectPrompts = project
        ? (
            this.db
              .prepare(
                `SELECT ${COLUMNS} FROM fork_quick_prompts WHERE scope='project' AND host_id=? AND project_id=? ORDER BY position, prompt_id`,
              )
              .all(project.hostId, project.projectId) as unknown as PromptRow[]
          ).map(toPrompt)
        : [];
      if (own) this.db.exec("COMMIT");
      return { project, globals, projectPrompts };
    } catch (error) {
      if (own && this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  readProjects(): QuickPromptProjectRef[] {
    return (
      this.db
        .prepare(
          "SELECT DISTINCT host_id AS hostId, project_id AS projectId FROM fork_quick_prompts WHERE scope='project' ORDER BY host_id, project_id",
        )
        .all() as unknown as Array<{ hostId: string; projectId: string }>
    ).map((row) => ({ hostId: row.hostId, projectId: row.projectId }));
  }

  create(input: QuickPromptCreateInput): QuickPrompt {
    return this.write(() => {
      assertTarget(input);
      assertGlobalBody(input.scope, input.body);
      const position = this.listCount(input);
      if (position >= QUICK_PROMPT_LIST_LIMIT) throw new Error("quick-prompt.limit-reached");
      const now = this.now();
      const prompt: QuickPrompt = {
        promptId: randomUUID(),
        scope: input.scope,
        project: input.scope === "global" ? null : input.project,
        name: input.name,
        body: input.body,
        color: input.color ?? null,
        pinned: input.pinned,
        position,
        createdAt: now,
        updatedAt: now,
      };
      this.insert(prompt);
      return prompt;
    });
  }

  update(input: QuickPromptUpdateInput): QuickPrompt {
    return this.write(() => {
      const current = this.require(input.promptId);
      const scope = input.scope ?? current.scope;
      // An omitted project follows the scope: moving to global clears it, otherwise the current project stays.
      const project =
        input.project !== undefined ? input.project : scope === "global" ? null : current.project;
      const next: Target & { name: string; body: QuickPromptBody } = {
        scope,
        project,
        name: input.name ?? current.name,
        body: input.body ?? current.body,
      };
      assertTarget(next);
      assertGlobalBody(next.scope, next.body);
      const moved = next.scope !== current.scope || !sameProject(next.project, current.project);
      const now = this.now();
      let position = current.position;
      if (moved) {
        position = this.listCount(next);
        if (position >= QUICK_PROMPT_LIST_LIMIT) throw new Error("quick-prompt.limit-reached");
        if (current.scope === "global") {
          this.db
            .prepare("DELETE FROM fork_quick_prompt_hidden WHERE prompt_id=?")
            .run(current.promptId);
        }
      }
      this.db
        .prepare(
          // color is written only when the input carries it: the stored raw value may be a hue a newer build saved.
          `UPDATE fork_quick_prompts SET scope=?, host_id=?, project_id=?, name=?, body_markdown=?, body_nodes=?, position=?, updated_at=?${
            input.color !== undefined ? ", color=?" : ""
          } WHERE prompt_id=?`,
        )
        .run(
          next.scope,
          next.project?.hostId ?? null,
          next.project?.projectId ?? null,
          next.name,
          next.body.markdown,
          next.body.nodes,
          position,
          now,
          ...(input.color !== undefined ? [input.color] : []),
          current.promptId,
        );
      if (moved) this.renumber(current);
      return {
        ...current,
        ...next,
        color: input.color !== undefined ? input.color : current.color,
        project: next.project,
        position,
        updatedAt: now,
      };
    });
  }

  /** Returns false when the prompt was already gone, so the service does not broadcast a no-op. */
  delete(promptId: string): boolean {
    return this.write(() => {
      const row = this.find(promptId);
      if (!row) return false;
      const current = toPrompt(row);
      this.db.prepare("DELETE FROM fork_quick_prompt_hidden WHERE prompt_id=?").run(promptId);
      this.db.prepare("DELETE FROM fork_quick_prompts WHERE prompt_id=?").run(promptId);
      this.renumber(current);
      return true;
    });
  }

  duplicate(input: { promptId: string } & Target): QuickPrompt {
    return this.write(() => {
      const source = this.require(input.promptId);
      // The raw column is copied so a hue this build does not know survives duplication.
      const sourceRow = this.find(input.promptId);
      assertTarget(input);
      assertGlobalBody(input.scope, source.body);
      const position = this.listCount(input);
      if (position >= QUICK_PROMPT_LIST_LIMIT) throw new Error("quick-prompt.limit-reached");
      const now = this.now();
      const copy: QuickPrompt = {
        promptId: randomUUID(),
        scope: input.scope,
        project: input.scope === "global" ? null : input.project,
        name: source.name,
        body: { ...source.body },
        color: source.color,
        pinned: true,
        position,
        createdAt: now,
        updatedAt: now,
      };
      this.insert(copy, sourceRow?.color);
      return copy;
    });
  }

  setPinned(promptId: string, pinned: boolean): void {
    this.write(() => {
      this.require(promptId);
      this.db
        .prepare("UPDATE fork_quick_prompts SET pinned=? WHERE prompt_id=?")
        .run(pinned ? 1 : 0, promptId);
    });
  }

  setHidden(promptId: string, project: QuickPromptProjectRef, hidden: boolean): void {
    this.write(() => {
      const current = this.require(promptId);
      if (current.scope !== "global") throw new Error("quick-prompt.not-global");
      if (hidden) {
        this.db
          .prepare(
            "INSERT OR IGNORE INTO fork_quick_prompt_hidden (host_id, project_id, prompt_id) VALUES (?,?,?)",
          )
          .run(project.hostId, project.projectId, promptId);
      } else {
        this.db
          .prepare(
            "DELETE FROM fork_quick_prompt_hidden WHERE host_id=? AND project_id=? AND prompt_id=?",
          )
          .run(project.hostId, project.projectId, promptId);
      }
    });
  }

  reorder(target: Target, orderedIds: string[]): void {
    this.write(() => {
      assertTarget(target);
      const members = this.listRows(target).map((row) => row.prompt_id);
      const expected = new Set(members);
      const requested = new Set(orderedIds);
      if (
        orderedIds.length !== members.length ||
        requested.size !== members.length ||
        [...requested].some((id) => !expected.has(id))
      ) {
        throw new Error("quick-prompt.reorder-mismatch");
      }
      const update = this.db.prepare("UPDATE fork_quick_prompts SET position=? WHERE prompt_id=?");
      orderedIds.forEach((id, index) => update.run(index, id));
    });
  }

  private find(promptId: string): PromptRow | undefined {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM fork_quick_prompts WHERE prompt_id=?`)
      .get(promptId) as unknown as PromptRow | undefined;
  }

  private require(promptId: string): QuickPrompt {
    const row = this.find(promptId);
    if (!row) throw new Error("quick-prompt.not-found");
    return toPrompt(row);
  }

  private listRows(target: Target): PromptRow[] {
    return this.db
      .prepare(
        `SELECT ${COLUMNS} FROM fork_quick_prompts WHERE scope=? AND host_id IS ? AND project_id IS ? ORDER BY position, prompt_id`,
      )
      .all(
        target.scope,
        target.project?.hostId ?? null,
        target.project?.projectId ?? null,
      ) as unknown as PromptRow[];
  }

  private listCount(target: Target): number {
    return this.listRows(target).length;
  }

  /** Keeps positions dense (0..n-1) in the list a prompt just left or was removed from. */
  private renumber(from: Pick<QuickPrompt, "scope" | "project">): void {
    const rows = this.listRows({ scope: from.scope, project: from.project });
    const update = this.db.prepare("UPDATE fork_quick_prompts SET position=? WHERE prompt_id=?");
    rows.forEach((row, index) => {
      if (row.position !== index) update.run(index, row.prompt_id);
    });
  }

  private insert(prompt: QuickPrompt, rawColor?: unknown): void {
    this.db
      .prepare(`INSERT INTO fork_quick_prompts (${COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        prompt.promptId,
        prompt.scope,
        prompt.project?.hostId ?? null,
        prompt.project?.projectId ?? null,
        prompt.name,
        prompt.body.markdown,
        prompt.body.nodes,
        (rawColor === undefined ? prompt.color : rawColor) as string | null,
        prompt.pinned ? 1 : 0,
        prompt.position,
        prompt.createdAt,
        prompt.updatedAt,
      );
  }
}
