/**
 * Engine side of amend-resume: imported-cache hits, divergence, session seeds, and world content matching
 * (docs/execution-engine.md "Amend-resume").
 *
 * All cases use a fake driver: the cache is pure data injection; the only things to verify on the engine side
 * are "what hit, what was passed, and what rows were written".
 * How the driver copies the transcript after receiving a seed is the bootstrap side's business (idempotency is
 * verified there).
 */

import { describe, expect, it } from "vitest";
import {
  InMemoryJournalStore,
  WorkflowEngine,
  inputHash,
  type AskSpec,
  type AskStats,
  type Caps,
  type ImportedActorCandidate,
  type ImportedAskEntry,
  type ImportedRunCache,
  type ImportedWorldEntry,
  type NodeRecord,
  type PersonaSpec,
  type WorldReadOp,
} from "../../src/engine/index.js";
import { FakeDriver, flush } from "./fake-driver.js";

const RUN = "run-b";

/** Explicitly mark several ask sites as untyped (the engine no longer treats absence as untyped). */
const untypedSpecs = (...siteIds: string[]): Map<string, AskSpec> =>
  new Map(siteIds.map((id) => [id, { typed: false } as AskSpec]));

const ASK_SITES = untypedSpecs("ask#1", "ask#2", "ask#3", "ask#4", "ask#5", "ask#6", "ask#7");

interface SetupOpts {
  journal?: InMemoryJournalStore;
  caps?: Caps;
  importedCache?: ImportedRunCache;
  inheritedTokens?: number;
}

function setup(opts: SetupOpts = {}) {
  const journal = opts.journal ?? new InMemoryJournalStore();
  const driver = new FakeDriver(journal);
  const engine = new WorkflowEngine({
    runId: RUN,
    driver,
    caps: opts.caps ?? { maxConcurrency: 16 },
    askSpecs: ASK_SITES,
    validate: () => [],
    resumedFrom: "run-a",
    ...(opts.importedCache === undefined ? {} : { importedCache: opts.importedCache }),
    ...(opts.inheritedTokens === undefined ? {} : { inheritedTokens: opts.inheritedTokens }),
  });
  return { journal, driver, engine };
}

/** One imported ask entry: the hash is derived from the instruction body (same source as the engine's inputHash). */
function entry(
  instructions: string,
  result: unknown,
  messageBoundary: number,
  stats?: AskStats,
): ImportedAskEntry {
  return {
    inputHash: inputHash(instructions),
    result,
    messageBoundary,
    ...(stats === undefined ? {} : { stats }),
  };
}

function candidate(
  entries: ImportedAskEntry[],
  overrides: Partial<ImportedActorCandidate> = {},
): ImportedActorCandidate {
  return {
    persona: { name: "planner" },
    entries,
    transcriptSourceSessionId: "sess-a",
    resolvedModel: "zhipu/glm-5.3",
    ...overrides,
  };
}

/** Content key of a world node: same source as the engine's `inputHash({op, args})`. */
const worldKey = (op: WorldReadOp, args: unknown[]): string => inputHash({ op, args });

function worldEntry(op: WorldReadOp, args: unknown[], result: unknown): ImportedWorldEntry {
  return {
    inputHash: worldKey(op, args),
    kind: op === "run" ? "world-run" : "world-read",
    result,
  };
}

function cacheOf(
  actors: Array<[string, ImportedActorCandidate]>,
  world: Array<[string, ImportedWorldEntry[]]> = [],
): ImportedRunCache {
  return { actors: new Map(actors), world: new Map(world) };
}

describe("导入缓存 — 全命中", () => {
  it("零 driver 往返；节点行拷贝 result/stats/边界；事件只有 node-settled(cached)", async () => {
    const cache = cacheOf(
      [
        [
          "planner",
          candidate([
            entry("step 1", "r1", 4, { tokens: 10, toolCalls: 1, turns: 2 }),
            entry("step 2", "r2", 9),
          ]),
        ],
      ],
      [[worldKey("grep", ["todo"]), [worldEntry("grep", ["todo"], ["a.ts"])]]],
    );
    const { engine, driver, journal } = setup({ importedCache: cache });

    const planner = engine.createActor("actor#1", "planner");
    const p1 = engine.ask("ask#1", planner, "step 1");
    const p2 = engine.ask("ask#2", planner, "step 2");
    const w = engine.worldRead("world#1", "grep", ["todo"]);
    await flush();

    await expect(p1).resolves.toBe("r1");
    await expect(p2).resolves.toBe("r2");
    await expect(w).resolves.toEqual(["a.ts"]);

    // Zero tokens, zero side effects: no session was ever created.
    expect(driver.sessionCreations).toHaveLength(0);
    expect(driver.startAskCount()).toBe(0);
    expect(driver.worldReads).toHaveLength(0);

    const settled = driver.eventsOfType("node-settled");
    expect(settled).toHaveLength(3);
    expect(settled.every((e) => e.cached === true)).toBe(true);
    // A cached settle takes the same posture as a replay hit: no queueing, no dispatch.
    expect(driver.eventsOfType("node-queued")).toHaveLength(0);
    expect(driver.eventsOfType("node-dispatched")).toHaveLength(0);

    expect(journal.getNode(RUN, "ask#1", 1)).toMatchObject({
      kind: "ask",
      status: "completed",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 0,
      inputHash: inputHash("step 1"),
      result: "r1",
      messageBoundary: 4,
      stats: { tokens: 10, toolCalls: 1, turns: 2 },
    });
    const second = journal.getNode(RUN, "ask#2", 1);
    expect(second).toMatchObject({ actorSeq: 1, result: "r2", messageBoundary: 9 });
    expect(second?.stats).toBeUndefined();
    expect(journal.getNode(RUN, "world#1", 1)).toMatchObject({
      kind: "world-read",
      status: "completed",
      result: ["a.ts"],
    });

    engine.complete("done");
    await expect(engine.settled).resolves.toEqual({ status: "completed", artifact: "done" });
  });
});

describe("导入缓存 — 命中的结算重发出生事实（docs/execution-engine.md「Events」）", () => {
  it("ask 命中：kind / actor / actorSeq / 任务摘要 + 前驱会话；world 命中照旧是裸的", async () => {
    const cache = cacheOf(
      [["planner", candidate([entry("  step 1  ", "r1", 4), entry("step 2", "r2", 9)])]],
      [[worldKey("grep", ["todo"]), [worldEntry("grep", ["todo"], ["a.ts"])]]],
    );
    const { engine, driver } = setup({ importedCache: cache });

    const planner = engine.createActor("actor#1", "planner");
    const p1 = engine.ask("ask#1", planner, "  step 1  ");
    const p2 = engine.ask("ask#2", planner, "step 2");
    const w = engine.worldRead("world#1", "grep", ["todo"]);
    await flush();
    await Promise.all([p1, p2, w]);

    // A hit has no node-queued, so this settle is the birth event: the read surface uses it to attribute the
    // node to the subagent; the answer is read from the predecessor's session (this run did not create a
    // session for it), and the transcript must be looked at there.
    expect(driver.eventsOfType("node-settled")).toEqual([
      {
        type: "node-settled",
        instance: { siteId: "ask#1", ordinal: 1 },
        outcome: "ok",
        cached: true,
        kind: "ask",
        actor: { siteId: "actor#1", ordinal: 1 },
        actorSeq: 0,
        // Same summarization rule as node-queued: trim both ends, no ellipsis.
        instructionsHead: "step 1",
        sourceSessionId: "sess-a",
      },
      {
        type: "node-settled",
        instance: { siteId: "ask#2", ordinal: 1 },
        outcome: "ok",
        cached: true,
        kind: "ask",
        actor: { siteId: "actor#1", ordinal: 1 },
        actorSeq: 1,
        instructionsHead: "step 2",
        sourceSessionId: "sess-a",
      },
      { type: "node-settled", instance: { siteId: "world#1", ordinal: 1 }, outcome: "ok", cached: true },
    ]);
  });

  it("命中之后分歧的 live ask 走 node-queued；它前面的命中仍指向前驱会话", async () => {
    const cache = cacheOf([["planner", candidate([entry("s0", "r0", 4), entry("旧指令", "r1", 9)])]]);
    const { engine, driver } = setup({ importedCache: cache });
    const planner = engine.createActor("actor#1", "planner");
    const p0 = engine.ask("ask#1", planner, "s0");
    const p1 = engine.ask("ask#2", planner, "新指令");
    await flush();
    await expect(p0).resolves.toBe("r0");

    const cachedSettles = driver.eventsOfType("node-settled").filter((e) => e.cached === true);
    expect(cachedSettles).toHaveLength(1);
    expect(cachedSettles[0]).toMatchObject({ actorSeq: 0, sourceSessionId: "sess-a" });
    expect(driver.eventsOfType("node-queued")).toMatchObject([
      { instance: { siteId: "ask#2", ordinal: 1 }, actorSeq: 1 },
    ]);
    engine.askTurnEnded({ siteId: "ask#2", ordinal: 1 }, "live-1");
    await expect(p1).resolves.toBe("live-1");
    // A live settle carries no birth facts and no predecessor session: the answer is in this run's own session.
    const liveSettle = driver.eventsOfType("node-settled").find((e) => e.instance.siteId === "ask#2");
    expect(liveSettle).toEqual({
      type: "node-settled",
      instance: { siteId: "ask#2", ordinal: 1 },
      outcome: "ok",
    });
  });
});

describe("导入缓存 — 分歧", () => {
  it("中途分歧：命中前缀保留，分歧点起全 live，后缀即便哈希相符也不再查", async () => {
    // entries[1]'s instructions differ from the new script ("旧指令" vs "s1") → seq 1 diverges;
    // entries[2] **deliberately** hashes the same as the new script's seq 2 instructions, to prove the cache
    // is no longer consulted after a divergence.
    const cache = cacheOf([
      ["planner", candidate([entry("s0", "r0", 4), entry("旧指令", "r1", 9), entry("s2", "r2", 14)])],
    ]);
    const { engine, driver, journal } = setup({ importedCache: cache });

    const planner = engine.createActor("actor#1", "planner");
    const p0 = engine.ask("ask#1", planner, "s0");
    const p1 = engine.ask("ask#2", planner, "s1");
    const p2 = engine.ask("ask#3", planner, "s2");
    await flush();

    await expect(p0).resolves.toBe("r0");
    expect(journal.getNode(RUN, "ask#1", 1)).toMatchObject({ status: "completed", result: "r0" });

    // The session is truncated at the last **consumed** entry: seq 1 diverges ⇒ the copied transcript = seq 0's complete exchange.
    expect(driver.sessionCreations).toHaveLength(1);
    expect(driver.sessionSeeds[0]).toEqual({
      sourceSessionId: "sess-a",
      messageCount: 4,
      resolvedModel: "zhipu/glm-5.3",
    });

    // Actors are serial: after the divergence the two asks are live-dispatched one by one; the second never consumes entries[2].
    expect(driver.startAskCount()).toBe(1);
    expect(driver.startAsks[0]?.instance.siteId).toBe("ask#2");
    engine.askTurnEnded({ siteId: "ask#2", ordinal: 1 }, "live-1");
    await flush();
    await expect(p1).resolves.toBe("live-1");

    expect(driver.startAskCount()).toBe(2);
    expect(driver.startAsks[1]?.instance.siteId).toBe("ask#3");
    engine.askTurnEnded({ siteId: "ask#3", ordinal: 1 }, "live-2");
    await expect(p2).resolves.toBe("live-2");
    expect(journal.getNode(RUN, "ask#3", 1)?.result).toBe("live-2");
    // Only seq 0 is a cache hit.
    expect(driver.eventsOfType("node-settled").filter((e) => e.cached === true)).toHaveLength(1);
  });

  it("越界扩展：导入条目用尽后新增的 ask 转 live，种子边界取最后一条", async () => {
    const cache = cacheOf([["planner", candidate([entry("s0", "r0", 7)])]]);
    const { engine, driver } = setup({ importedCache: cache });

    const planner = engine.createActor("actor#1", "planner");
    const p0 = engine.ask("ask#1", planner, "s0");
    const p1 = engine.ask("ask#2", planner, "s1");
    await flush();

    await expect(p0).resolves.toBe("r0");
    expect(driver.startAskCount()).toBe(1);
    expect(driver.startAsks[0]?.instance.siteId).toBe("ask#2");
    expect(driver.sessionSeeds[0]).toEqual({
      sourceSessionId: "sess-a",
      messageCount: 7,
      resolvedModel: "zhipu/glm-5.3",
    });

    engine.askTurnEnded({ siteId: "ask#2", ordinal: 1 }, "live");
    await expect(p1).resolves.toBe("live");
  });
});

describe("导入缓存 — actor 附着", () => {
  it("persona 不一致 = 全新 actor：不附着候选、全 live、建会话不带种子", async () => {
    const cache = cacheOf([
      ["planner", candidate([entry("s0", "r0", 4)], { persona: { name: "planner", system: "旧 prompt" } })],
    ]);
    const { engine, driver } = setup({ importedCache: cache });

    const planner = engine.createActor("actor#1", "planner", "新 prompt");
    const p0 = engine.ask("ask#1", planner, "s0");
    await flush();

    expect(driver.startAskCount()).toBe(1);
    expect(driver.sessionCreations).toHaveLength(1);
    expect(driver.sessionSeeds[0]).toBeUndefined();
    expect(driver.eventsOfType("node-settled").filter((e) => e.cached === true)).toHaveLength(0);

    engine.askTurnEnded({ siteId: "ask#1", ordinal: 1 }, "live");
    await expect(p0).resolves.toBe("live");
  });

  it("persona 比对是规范化的：缺席成员与显式 undefined 同值", async () => {
    const persona: PersonaSpec = { name: "planner", system: undefined };
    const cache = cacheOf([["planner", candidate([entry("s0", "r0", 4)], { persona })]]);
    const { engine, driver } = setup({ importedCache: cache });

    const planner = engine.createActor("actor#1", "planner");
    await expect(engine.ask("ask#1", planner, "s0")).resolves.toBe("r0");
    expect(driver.startAskCount()).toBe(0);
  });

  // docs/dynamic-workflow/authoring.md "Choosing a model per subagent": the model is not part of the cache identity.
  it("只改 persona 的 model：照样附着、照样命中；持久化的 persona 带新模型名", async () => {
    const cache = cacheOf([
      [
        "planner",
        candidate([entry("s0", "r0", 4)], {
          persona: { name: "planner", system: "你负责规划。", model: "GLM-5.3" },
        }),
      ],
    ]);
    const { engine, driver, journal } = setup({ importedCache: cache });

    const planner = engine.createActor("actor#1", "planner", {
      system: "你负责规划。",
      model: "GLM-5.3-Flash",
    });
    await expect(engine.ask("ask#1", planner, "s0")).resolves.toBe("r0");
    expect(driver.startAskCount()).toBe(0);
    expect(journal.getActor(RUN, "actor#1", 1)?.persona).toEqual({
      name: "planner",
      system: "你负责规划。",
      model: "GLM-5.3-Flash",
    });
  });

  it("model 从无到有同样不拆散附着；system 变了仍拆散", async () => {
    const cache = cacheOf([
      ["planner", candidate([entry("s0", "r0", 4)], { persona: { name: "planner" } })],
      ["judge", candidate([entry("j0", "v0", 4)], { persona: { name: "judge", system: "旧" } })],
    ]);
    const { engine, driver } = setup({ importedCache: cache });

    const planner = engine.createActor("actor#1", "planner", { model: "GLM-5.3-Flash" });
    const judge = engine.createActor("actor#2", "judge", { system: "新", model: "GLM-5.3-Flash" });
    await expect(engine.ask("ask#1", planner, "s0")).resolves.toBe("r0");
    const live = engine.ask("ask#2", judge, "j0");
    await flush();
    expect(driver.startAskCount()).toBe(1);
    engine.askTurnEnded({ siteId: "ask#2", ordinal: 1 }, "live");
    await expect(live).resolves.toBe("live");
  });

  it("匿名 actor 永不附着（名字就是缓存身份键）", async () => {
    const cache = cacheOf([["planner", candidate([entry("s0", "r0", 4)])]]);
    const { engine, driver } = setup({ importedCache: cache });

    const anon = engine.createActor("actor#1");
    const p0 = engine.ask("ask#1", anon, "s0");
    await flush();

    expect(driver.startAskCount()).toBe(1);
    expect(driver.sessionSeeds[0]).toBeUndefined();
    engine.askTurnEnded({ siteId: "ask#1", ordinal: 1 }, "live");
    await expect(p0).resolves.toBe("live");
  });
});

describe("导入缓存 — world 节点", () => {
  it("同 {op,args} 的第 n 次出现对第 n 条；耗尽或参数变更即 live", async () => {
    const cache = cacheOf(
      [],
      [
        [
          worldKey("grep", ["x"]),
          [worldEntry("grep", ["x"], "第一次"), worldEntry("grep", ["x"], "第二次")],
        ],
      ],
    );
    const { engine, driver } = setup({ importedCache: cache });

    await expect(engine.worldRead("world#1", "grep", ["x"])).resolves.toBe("第一次");
    await expect(engine.worldRead("world#1", "grep", ["x"])).resolves.toBe("第二次");
    expect(driver.worldReads).toHaveLength(0);

    // Queue exhausted → live.
    const third = engine.worldRead("world#1", "grep", ["x"]);
    expect(driver.worldReads).toHaveLength(1);
    driver.worldReads[0]?.deferred.resolve("现读");
    await expect(third).resolves.toBe("现读");

    // Args changed → different content key → live.
    const other = engine.worldRead("world#2", "grep", ["y"]);
    expect(driver.worldReads).toHaveLength(2);
    driver.worldReads[1]?.deferred.resolve("y 的结果");
    await expect(other).resolves.toBe("y 的结果");
  });

  it("world-run 命中绝不触 executeWorldRead（效应不静默重放），行 kind 为 world-run", async () => {
    const cache = cacheOf(
      [],
      [[worldKey("run", ["deploy.sh"]), [worldEntry("run", ["deploy.sh"], { exitCode: 0 })]]],
    );
    const { engine, driver, journal } = setup({ importedCache: cache });

    await expect(engine.worldRead("world#1", "run", ["deploy.sh"])).resolves.toEqual({ exitCode: 0 });
    expect(driver.worldReads).toHaveLength(0);
    expect(journal.getNode(RUN, "world#1", 1)).toMatchObject({
      kind: "world-run",
      status: "completed",
      inputHash: worldKey("run", ["deploy.sh"]),
      result: { exitCode: 0 },
    });
  });
});

describe("导入缓存 — 崩溃后 resume 的分歧重建", () => {
  it("据 journal 行逐 seq 重推分歧点：原次已分歧的 actor 不会被后缀哈希意外命中", async () => {
    // The amended run's original execution: seq 0 hit the import, seq 1 diverged (instructions differ from
    // entries[1]) and everything after went live; all three rows are completed and persisted, then the process
    // died. On resume the cache is rebuilt wholesale — if divergence were not re-derived, entries[3] below
    // hashes the same as the new ask at seq 3 and would wrongly import a piece of unrelated history.
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
      resumedFrom: "run-a",
    });
    const recordedAsk = (siteId: string, seq: number, instructions: string): NodeRecord => ({
      runId: RUN,
      siteId,
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: seq,
      inputHash: inputHash(instructions),
      status: "completed",
      result: `journal-${seq}`,
    });
    journal.putNode(recordedAsk("ask#1", 0, "s0"));
    journal.putNode(recordedAsk("ask#2", 1, "s1"));
    journal.putNode(recordedAsk("ask#3", 2, "s2"));

    const cache = cacheOf([
      [
        "planner",
        candidate([
          entry("s0", "r0", 4),
          entry("与新脚本不同的旧指令", "r1", 9),
          entry("s2", "r2", 14),
          entry("s3", "r3", 19),
        ]),
      ],
    ]);
    const { engine, driver } = setup({ journal, importedCache: cache });

    const planner = engine.createActor("actor#1", "planner");
    const p0 = engine.ask("ask#1", planner, "s0");
    const p1 = engine.ask("ask#2", planner, "s1");
    const p2 = engine.ask("ask#3", planner, "s2");
    const p3 = engine.ask("ask#4", planner, "s3");
    await flush();

    // The three rows short-circuit via replay (results come from the journal, not the imported entries).
    await expect(p0).resolves.toBe("journal-0");
    await expect(p1).resolves.toBe("journal-1");
    await expect(p2).resolves.toBe("journal-2");

    // Replayed settles re-emit the birth facts too. The seq 0 row was an import hit in the original run, so the
    // exchange lives only in the predecessor's session; from seq 1 on, the original run had diverged and ran
    // live, and this run's own sessions hold them (the seed already copied the prefix).
    expect(
      driver
        .eventsOfType("node-settled")
        .filter((e) => e.cached === true)
        .map((e) => ({ seq: e.actorSeq, actor: e.actor, kind: e.kind, source: e.sourceSessionId })),
    ).toEqual([
      { seq: 0, actor: { siteId: "actor#1", ordinal: 1 }, kind: "ask", source: "sess-a" },
      { seq: 1, actor: { siteId: "actor#1", ordinal: 1 }, kind: "ask", source: undefined },
      { seq: 2, actor: { siteId: "actor#1", ordinal: 1 }, kind: "ask", source: undefined },
    ]);

    // Key assertion: seq 3 hashes the same as entries[3], but the original run had already diverged at seq 1 → must go live.
    expect(driver.startAskCount()).toBe(1);
    expect(driver.startAsks[0]?.instance.siteId).toBe("ask#4");
    // The consumption count only reaches seq 0 (entries[0]'s boundary); the seed is truncated accordingly.
    expect(driver.sessionSeeds[0]).toEqual({
      sourceSessionId: "sess-a",
      messageCount: 4,
      resolvedModel: "zhipu/glm-5.3",
    });

    engine.askTurnEnded({ siteId: "ask#4", ordinal: 1 }, "live-3");
    await expect(p3).resolves.toBe("live-3");
  });
});

describe("导入缓存 — 关闭（第一笔写入之前，不是第一个 live ask）", () => {
  const NPM_TEST = ["npm", ["test"]];
  const README = ["README.md"];
  // Pure entry: only answered, never touched the outside world (protocol tools like `submit_result` count toward toolCalls, not worldToolCalls).
  const PURE: AskStats = { tokens: 10, toolCalls: 1, turns: 1, worldToolCalls: 0 };
  // Entry that touched the outside world: read files / ran commands; after the gate closes, even identical hashes no longer hit.
  const TOOLED: AskStats = { tokens: 10, toolCalls: 3, turns: 1, worldToolCalls: 2 };

  /** Predecessor table with four subagents + two world records. planner / summarizer are pure asks; fixer / reviewer use tools. */
  function closingCache(): ImportedRunCache {
    return cacheOf(
      [
        ["planner", candidate([entry("plan", "r-plan", 4, PURE)])],
        [
          "fixer",
          candidate([entry("旧的修复指令", "r-old-fix", 5, TOOLED)], { persona: { name: "fixer" } }),
        ],
        [
          "reviewer",
          candidate(
            [entry("review-1", "r-review-1", 6, TOOLED), entry("review-2", "r-review-2", 11, TOOLED)],
            { persona: { name: "reviewer" } },
          ),
        ],
        [
          "summarizer",
          candidate([entry("summarize", "r-sum", 7, PURE), entry("summarize-2", "r-sum-2", 9, PURE)], {
            persona: { name: "summarizer" },
          }),
        ],
      ],
      [
        [
          worldKey("run", NPM_TEST),
          [worldEntry("run", NPM_TEST, { exitCode: 0, round: 1 }), worldEntry("run", NPM_TEST, { exitCode: 0, round: 2 })],
        ],
        [worldKey("read", README), [worldEntry("read", README, "old readme")]],
      ],
    );
  }

  const closedEvents = (driver: FakeDriver) => driver.eventsOfType("import-cache-closed");

  it("扇出里第一个未命中的 ask 转 live 不关门：排在它后面的兄弟照常命中（2026-09-14 实测的两次丢命中）", async () => {
    const { engine, driver } = setup({ importedCache: closingCache() });
    const fixer = engine.createActor("actor#2", "fixer");
    const planner = engine.createActor("actor#1", "planner");
    const reviewer = engine.createActor("actor#3", "reviewer");

    // Issued within the same tick in the order fixer → planner → reviewer → world-run: fixer misses (the
    // predecessor never finished it), the other three are all in the predecessor table. The old rule closed the
    // gate the moment fixer was queued, forcing all three later ones to rerun.
    const fix = engine.ask("ask#3", fixer, "修好 parser");
    const plan = engine.ask("ask#1", planner, "plan");
    const review = engine.ask("ask#2", reviewer, "review-1");
    const test = engine.worldRead("world#1", "run", NPM_TEST);
    await flush();
    await expect(plan).resolves.toBe("r-plan");
    await expect(review).resolves.toBe("r-review-1");
    await expect(test).resolves.toEqual({ exitCode: 0, round: 1 });
    expect(driver.startAskCount()).toBe(1);
    expect(driver.startAsks[0]?.instance.siteId).toBe("ask#3");
    expect(driver.worldReads).toHaveLength(0);
    expect(closedEvents(driver)).toHaveLength(0);
    expect(driver.eventsOfType("log")).toHaveLength(0);

    engine.askTurnEnded({ siteId: "ask#3", ordinal: 1 }, "fixed");
    await expect(fix).resolves.toBe("fixed");
  });

  it("askMutating 关门：之后带工具的条目与 world 节点全 live，纯 ask 仍命中；恰好一条 import-cache-closed", async () => {
    const { engine, driver } = setup({ importedCache: closingCache() });
    const fixer = engine.createActor("actor#2", "fixer");
    const reviewer = engine.createActor("actor#3", "reviewer");
    const summarizer = engine.createActor("actor#4", "summarizer");

    // Before the gate closes: reviewer's first ask hits.
    await expect(engine.ask("ask#2", reviewer, "review-1")).resolves.toBe("r-review-1");

    // fixer misses and goes live; its subagent is about to write a file — the driver reports askMutating ⇒ the gate closes, and the event names fixer.
    const fix = engine.ask("ask#3", fixer, "修好 parser");
    await flush();
    expect(driver.startAskCount()).toBe(1);
    expect(closedEvents(driver)).toHaveLength(0);
    engine.askMutating({ siteId: "ask#3", ordinal: 1 });
    const closed = closedEvents(driver);
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({
      instance: { siteId: "ask#3", ordinal: 1 },
      cause: "mutating-tool",
      actorName: "fixer",
    });
    // Reporting again is a no-op (closing is monotonic).
    engine.askMutating({ siteId: "ask#3", ordinal: 1 });
    expect(closedEvents(driver)).toHaveLength(1);

    // After the gate closes: the second same-hash world-run record is still in the table but never hits again — live execution.
    const rerun = engine.worldRead("world#1", "run", NPM_TEST);
    expect(driver.worldReads).toHaveLength(1);
    driver.worldReads[0]?.deferred.resolve({ exitCode: 1, round: "live" });
    await expect(rerun).resolves.toEqual({ exitCode: 1, round: "live" });
    // Same for world-read.
    const readme = engine.worldRead("world#2", "read", README);
    expect(driver.worldReads).toHaveLength(2);
    driver.worldReads[1]?.deferred.resolve("new readme");
    await expect(readme).resolves.toBe("new readme");

    // reviewer uses tools: its second ask hashes the same as entries[1] and still goes live after the gate
    // closes (it reads the rewritten repository); the seed is truncated at the consumed prefix (entries[0]'s
    // boundary of 6), not entries[1]'s 11.
    const review2 = engine.ask("ask#4", reviewer, "review-2");
    await flush();
    expect(driver.startAskCount()).toBe(2);
    expect(driver.startAsks[1]?.instance.siteId).toBe("ask#4");
    const reviewerSeed = driver.sessionSeeds[driver.sessionCreations.findIndex((ref) => ref.siteId === "actor#3")];
    expect(reviewerSeed).toEqual({ sourceSessionId: "sess-a", messageCount: 6, resolvedModel: "zhipu/glm-5.3" });

    // summarizer is a pure ask (toolCalls 0): both hit after the gate closes — it depends only on the instructions and the transcript prefix, not on the workspace.
    await expect(engine.ask("ask#5", summarizer, "summarize")).resolves.toBe("r-sum");
    await expect(engine.ask("ask#5", summarizer, "summarize-2")).resolves.toBe("r-sum-2");
    expect(driver.startAskCount()).toBe(2);

    engine.askTurnEnded({ siteId: "ask#3", ordinal: 1 }, "fixed");
    await expect(fix).resolves.toBe("fixed");
    engine.askTurnEnded({ siteId: "ask#4", ordinal: 1 }, "reviewed");
    await expect(review2).resolves.toBe("reviewed");
    expect(closedEvents(driver)).toHaveLength(1);
  });

  it("老条目（stats 里没有 worldToolCalls）关门后按「碰过」处理：保守转 live", async () => {
    const legacy = cacheOf([
      ["planner", candidate([entry("plan", "r-plan", 4, { tokens: 5, toolCalls: 1, turns: 1 })])],
      ["fixer", candidate([entry("旧的修复指令", "r-old-fix", 5, TOOLED)], { persona: { name: "fixer" } })],
    ]);
    const { engine, driver } = setup({ importedCache: legacy });
    const fixer = engine.createActor("actor#2", "fixer");
    const planner = engine.createActor("actor#1", "planner");
    const fix = engine.ask("ask#3", fixer, "修好 parser");
    await flush();
    engine.askMutating({ siteId: "ask#3", ordinal: 1 });

    // planner's entry hashes match and it wrote nothing, but that journal version did not have the worldToolCalls key yet ⇒ treated as touched.
    const plan = engine.ask("ask#1", planner, "plan");
    await flush();
    expect(driver.startAskCount()).toBe(2);
    engine.askTurnEnded({ siteId: "ask#1", ordinal: 1 }, "planned live");
    await expect(plan).resolves.toBe("planned live");
    engine.askTurnEnded({ siteId: "ask#3", ordinal: 1 }, "fixed");
    await expect(fix).resolves.toBe("fixed");
  });

  it("关门后纯 actor 的链一旦有一条转 live，后缀即便是纯条目也不再命中（转录已不同）", async () => {
    const { engine, driver } = setup({ importedCache: closingCache() });
    const fixer = engine.createActor("actor#2", "fixer");
    const summarizer = engine.createActor("actor#4", "summarizer");

    const fix = engine.ask("ask#3", fixer, "修好 parser");
    await flush();
    engine.askMutating({ siteId: "ask#3", ordinal: 1 });

    // summarizer's first ask changed the instructions ⇒ miss goes live ⇒ divergence; the second hashes the same
    // as entries[1] and is a pure entry, but its transcript prefix is already the live round, so it cannot take
    // the predecessor's answer.
    const sum1 = engine.ask("ask#5", summarizer, "换一种总结");
    await flush();
    expect(driver.startAskCount()).toBe(2);
    engine.askTurnEnded({ siteId: "ask#5", ordinal: 1 }, "summary");
    await expect(sum1).resolves.toBe("summary");
    const sum2 = engine.ask("ask#5", summarizer, "summarize-2");
    await flush();
    expect(driver.startAskCount()).toBe(3);
    engine.askTurnEnded({ siteId: "ask#5", ordinal: 2 }, "summary-2");
    await expect(sum2).resolves.toBe("summary-2");

    engine.askTurnEnded({ siteId: "ask#3", ordinal: 1 }, "fixed");
    await expect(fix).resolves.toBe("fixed");
  });

  it("askMutating 对不在飞的实例是 no-op：迟到的观察不关门", async () => {
    const { engine, driver } = setup({ importedCache: closingCache() });
    const planner = engine.createActor("actor#1", "planner");
    // The hit ask never went live; reporting against its instance does not count.
    await expect(engine.ask("ask#1", planner, "plan")).resolves.toBe("r-plan");
    engine.askMutating({ siteId: "ask#1", ordinal: 1 });
    engine.askMutating({ siteId: "ask#9", ordinal: 1 });
    expect(closedEvents(driver)).toHaveLength(0);
    await expect(engine.worldRead("world#1", "run", NPM_TEST)).resolves.toEqual({ exitCode: 0, round: 1 });
  });

  it("live 的 world-run 是一笔写入：派发前关门；live 的 world-read 不关", async () => {
    const { engine, driver } = setup({ importedCache: closingCache() });
    const summarizer = engine.createActor("actor#4", "summarizer");
    const reviewer = engine.createActor("actor#3", "reviewer");

    // The world-read with new args goes live on its own (not in the table); afterwards a same-hash world-read still hits: reads do not close the gate.
    const peek = engine.worldRead("world#4", "read", ["CHANGELOG.md"]);
    expect(driver.worldReads).toHaveLength(1);
    driver.worldReads[0]?.deferred.resolve("changelog");
    await expect(peek).resolves.toBe("changelog");
    await expect(engine.worldRead("world#2", "read", README)).resolves.toBe("old readme");
    expect(closedEvents(driver)).toHaveLength(0);

    // A world-run with a new hash going live ⇒ the gate closes (the event precedes node-queued: close the gate before acting).
    const patch = engine.worldRead("world#3", "run", ["sed", ["-i", "s/a/b/", "x.ts"]]);
    expect(driver.worldReads).toHaveLength(2);
    const closedAt = driver.events.findIndex((e) => e.type === "import-cache-closed");
    const queuedAt = driver.events.findIndex(
      (e) => e.type === "node-queued" && e.instance.siteId === "world#3",
    );
    expect(closedAt).toBeGreaterThanOrEqual(0);
    expect(closedAt).toBeLessThan(queuedAt);
    expect(closedEvents(driver)[0]).toMatchObject({ instance: { siteId: "world#3", ordinal: 1 }, cause: "world-run" });
    driver.worldReads[1]?.deferred.resolve({ exitCode: 0 });
    await expect(patch).resolves.toEqual({ exitCode: 0 });

    // After the gate closes: the same-hash world-run record is still in the table but no longer hits — live; the tool-using reviewer also goes live; the pure summarizer still hits.
    const rerun = engine.worldRead("world#1", "run", NPM_TEST);
    expect(driver.worldReads).toHaveLength(3);
    driver.worldReads[2]?.deferred.resolve({ exitCode: 1, round: "live" });
    await expect(rerun).resolves.toEqual({ exitCode: 1, round: "live" });
    const review = engine.ask("ask#2", reviewer, "review-1");
    await flush();
    expect(driver.startAskCount()).toBe(1);
    await expect(engine.ask("ask#5", summarizer, "summarize")).resolves.toBe("r-sum");
    engine.askTurnEnded({ siteId: "ask#2", ordinal: 1 }, "reviewed");
    await expect(review).resolves.toBe("reviewed");
  });

  it("崩溃后 resume：从 import-cache-closed 事件恢复「已关闭」；曾 live 的 ask 行不推进消费游标", async () => {
    // Original execution: reviewer seq0 hit; fixer seq0 went live and wrote a file (gate closed); reviewer seq1
    // hashed the same as entries[1] but went live because of the gate; then the process died. All three rows
    // are completed. The events contain two node-queued (hits do not queue) and one gate closure.
    const journal = new InMemoryJournalStore();
    journal.createRun({ runId: RUN, caps: { maxConcurrency: 16 }, spentTokens: 0, status: "running", resumedFrom: "run-a" });
    journal.putActor({ runId: RUN, siteId: "actor#2", ordinal: 1, name: "fixer", persona: { name: "fixer" } });
    journal.putActor({
      runId: RUN,
      siteId: "actor#3",
      ordinal: 1,
      name: "reviewer",
      persona: { name: "reviewer" },
    });
    const row = (siteId: string, actor: [string, number], seq: number, instructions: string): NodeRecord => ({
      runId: RUN,
      siteId,
      ordinal: 1,
      kind: "ask",
      actorSiteId: actor[0],
      actorOrdinal: actor[1],
      actorSeq: seq,
      inputHash: inputHash(instructions),
      status: "completed",
      result: `journal-${siteId}`,
    });
    journal.putNode(row("ask#2", ["actor#3", 1], 0, "review-1"));
    journal.putNode(row("ask#3", ["actor#2", 1], 0, "修好 parser"));
    journal.putNode(row("ask#4", ["actor#3", 1], 1, "review-2"));
    journal.appendEvent(RUN, {
      type: "node-queued",
      instance: { siteId: "ask#3", ordinal: 1 },
      kind: "ask",
      actor: { siteId: "actor#2", ordinal: 1 },
      actorSeq: 0,
    });
    journal.appendEvent(RUN, {
      type: "import-cache-closed",
      instance: { siteId: "ask#3", ordinal: 1 },
      cause: "mutating-tool",
      actorName: "fixer",
    });
    journal.appendEvent(RUN, {
      type: "node-queued",
      instance: { siteId: "ask#4", ordinal: 1 },
      kind: "ask",
      actor: { siteId: "actor#3", ordinal: 1 },
      actorSeq: 1,
    });

    const { engine, driver } = setup({ journal, importedCache: closingCache() });
    const fixer = engine.createActor("actor#2", "fixer");
    const reviewer = engine.createActor("actor#3", "reviewer");

    // The prefix short-circuits via the journal.
    await expect(engine.ask("ask#2", reviewer, "review-1")).resolves.toBe("journal-ask#2");
    await expect(engine.ask("ask#3", fixer, "修好 parser")).resolves.toBe("journal-ask#3");
    await expect(engine.ask("ask#4", reviewer, "review-2")).resolves.toBe("journal-ask#4");
    // resume does not re-emit the gate-closed event: the verdict is restored, not newly occurring.
    expect(closedEvents(driver)).toHaveLength(0);
    // The predecessor session only follows the row that was an **import hit in the original run**: reviewer
    // seq0. fixer seq0 and reviewer seq1 both ran live originally (the latter even though it hashed the same as
    // the imported entry); their exchanges are in this run's own sessions.
    expect(
      driver
        .eventsOfType("node-settled")
        .filter((e) => e.cached === true)
        .map((e) => [e.instance.siteId, e.sourceSessionId]),
    ).toEqual([
      ["ask#2", "sess-a"],
      ["ask#3", undefined],
      ["ask#4", undefined],
    ]);

    // Beyond the prefix: a world-run present in the table no longer hits.
    const rerun = engine.worldRead("world#1", "run", NPM_TEST);
    expect(driver.worldReads).toHaveLength(1);
    driver.worldReads[0]?.deferred.resolve({ exitCode: 0, round: "live" });
    await expect(rerun).resolves.toEqual({ exitCode: 0, round: "live" });

    // reviewer's seq2 goes live; the seed boundary = the last hit before the gate closed (entries[0]'s 6), not
    // entries[1] (11), which happens to hash the same as the seq1 row — that row ran live originally.
    const review3 = engine.ask("ask#5", reviewer, "review-3");
    await flush();
    expect(driver.startAskCount()).toBe(1);
    expect(driver.startAsks[0]?.instance.siteId).toBe("ask#5");
    expect(driver.sessionSeeds[0]).toEqual({ sourceSessionId: "sess-a", messageCount: 6, resolvedModel: "zhipu/glm-5.3" });
    engine.askTurnEnded({ siteId: "ask#5", ordinal: 1 }, "reviewed");
    await expect(review3).resolves.toBe("reviewed");
  });

  it("崩溃后 resume：只有 live ask、没有关门事件 ⇒ 门仍开着，表里的条目照常命中", async () => {
    // Original run: fixer seq0 went live (a miss) but wrote no files; the process died. The old rule would read this node-queued as "the gate is closed".
    const journal = new InMemoryJournalStore();
    journal.createRun({ runId: RUN, caps: { maxConcurrency: 16 }, spentTokens: 0, status: "running", resumedFrom: "run-a" });
    journal.putActor({ runId: RUN, siteId: "actor#2", ordinal: 1, name: "fixer", persona: { name: "fixer" } });
    journal.putNode({
      runId: RUN,
      siteId: "ask#3",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#2",
      actorOrdinal: 1,
      actorSeq: 0,
      inputHash: inputHash("修好 parser"),
      status: "completed",
      result: "journal-ask#3",
    });
    journal.appendEvent(RUN, {
      type: "node-queued",
      instance: { siteId: "ask#3", ordinal: 1 },
      kind: "ask",
      actor: { siteId: "actor#2", ordinal: 1 },
      actorSeq: 0,
    });

    const { engine, driver } = setup({ journal, importedCache: closingCache() });
    const fixer = engine.createActor("actor#2", "fixer");
    const reviewer = engine.createActor("actor#3", "reviewer");
    await expect(engine.ask("ask#3", fixer, "修好 parser")).resolves.toBe("journal-ask#3");
    await expect(engine.ask("ask#2", reviewer, "review-1")).resolves.toBe("r-review-1");
    await expect(engine.worldRead("world#1", "run", NPM_TEST)).resolves.toEqual({ exitCode: 0, round: 1 });
    expect(driver.startAskCount()).toBe(0);
    expect(driver.worldReads).toHaveLength(0);
  });
});

describe("导入缓存 — 续跑前驱的在飞 ask（docs/execution-engine.md「How the engine consumes the cache」）", () => {
  /** The ask the predecessor left in flight: the hash is derived from the instruction body, and the boundary is the message count of the predecessor's **entire session**. */
  const inFlightOf = (instructions: string, messageBoundary: number) => ({
    inputHash: inputHash(instructions),
    messageBoundary,
  });

  const cachedSettles = (driver: FakeDriver) =>
    driver.eventsOfType("node-settled").filter((e) => e.cached === true);

  it("同一条 ask（哈希相符）：种子带整段半场转录，ask 仍 live 跑而不是从缓存结算", async () => {
    const cache = cacheOf([
      ["planner", candidate([entry("s0", "r0", 4)], { inFlight: inFlightOf("s1", 12) })],
    ]);
    const { engine, driver, journal } = setup({ importedCache: cache });

    const planner = engine.createActor("actor#1", "planner");
    await expect(engine.ask("ask#1", planner, "s0")).resolves.toBe("r0");

    const p1 = engine.ask("ask#2", planner, "s1");
    await flush();

    // Carry-over is not a hit: there is no result to import, so this one is dispatched as usual.
    expect(driver.startAskCount()).toBe(1);
    expect(driver.startAsks[0]?.instance.siteId).toBe("ask#2");
    expect(cachedSettles(driver)).toHaveLength(1);
    // The seed takes inFlight's boundary (12), not the last prefix entry's 4.
    expect(driver.sessionSeeds[0]).toEqual({
      sourceSessionId: "sess-a",
      messageCount: 12,
      resolvedModel: "zhipu/glm-5.3",
    });

    engine.askTurnEnded({ siteId: "ask#2", ordinal: 1 }, "live-1");
    await expect(p1).resolves.toBe("live-1");
    expect(journal.getNode(RUN, "ask#2", 1)?.result).toBe("live-1");
  });

  it("一条都没做完的候选（entries 为空 + inFlight）：扇出第一轮在飞时被修订的常见形状", async () => {
    const cache = cacheOf([["planner", candidate([], { inFlight: inFlightOf("s0", 6) })]]);
    const { engine, driver } = setup({ importedCache: cache });

    const planner = engine.createActor("actor#1", "planner");
    const p0 = engine.ask("ask#1", planner, "s0");
    await flush();

    expect(driver.startAskCount()).toBe(1);
    expect(cachedSettles(driver)).toHaveLength(0);
    // There is a seed even with a consumption count of 0 — exactly the dividing line between carry-over and "diverged-prefix truncation".
    expect(driver.sessionSeeds[0]).toEqual({
      sourceSessionId: "sess-a",
      messageCount: 6,
      resolvedModel: "zhipu/glm-5.3",
    });

    engine.askTurnEnded({ siteId: "ask#1", ordinal: 1 }, "live-0");
    await expect(p0).resolves.toBe("live-0");
  });

  it("指令变了（哈希不符）：退回老行为——前缀边界截断，没有前缀就没有种子", async () => {
    const withPrefix = cacheOf([
      ["planner", candidate([entry("s0", "r0", 4)], { inFlight: inFlightOf("旧的第二问", 12) })],
    ]);
    const first = setup({ importedCache: withPrefix });
    const planner = first.engine.createActor("actor#1", "planner");
    await expect(first.engine.ask("ask#1", planner, "s0")).resolves.toBe("r0");
    const p1 = first.engine.ask("ask#2", planner, "改过的第二问");
    await flush();
    expect(first.driver.sessionSeeds[0]).toEqual({
      sourceSessionId: "sess-a",
      messageCount: 4,
      resolvedModel: "zhipu/glm-5.3",
    });
    first.engine.askTurnEnded({ siteId: "ask#2", ordinal: 1 }, "live");
    await expect(p1).resolves.toBe("live");

    // Empty prefix + hash mismatch ⇒ a brand-new session, not even a seed.
    const noPrefix = cacheOf([
      ["planner", candidate([], { inFlight: inFlightOf("旧的第一问", 6) })],
    ]);
    const second = setup({ importedCache: noPrefix });
    const fresh = second.engine.createActor("actor#1", "planner");
    const p0 = second.engine.ask("ask#1", fresh, "改过的第一问");
    await flush();
    expect(second.driver.startAskCount()).toBe(1);
    expect(second.driver.sessionSeeds[0]).toBeUndefined();
    second.engine.askTurnEnded({ siteId: "ask#1", ordinal: 1 }, "live");
    await expect(p0).resolves.toBe("live");
  });

  it("门已关：半场转录里全是前驱对旧工作区的观察，不再续跑——退回前缀边界", async () => {
    const cache = cacheOf([
      ["planner", candidate([entry("s0", "r0", 4)], { inFlight: inFlightOf("s1", 12) })],
      ["fixer", candidate([], { persona: { name: "fixer" } })],
    ]);
    const { engine, driver } = setup({ importedCache: cache });

    const fixer = engine.createActor("actor#2", "fixer");
    const planner = engine.createActor("actor#1", "planner");
    await expect(engine.ask("ask#1", planner, "s0")).resolves.toBe("r0");

    // fixer misses, goes live and writes a file ⇒ the gate closes.
    const fix = engine.ask("ask#3", fixer, "修好 parser");
    await flush();
    engine.askMutating({ siteId: "ask#3", ordinal: 1 });
    expect(driver.eventsOfType("import-cache-closed")).toHaveLength(1);

    const p1 = engine.ask("ask#2", planner, "s1");
    await flush();
    const plannerSeed =
      driver.sessionSeeds[driver.sessionCreations.findIndex((ref) => ref.siteId === "actor#1")];
    expect(plannerSeed).toEqual({
      sourceSessionId: "sess-a",
      messageCount: 4,
      resolvedModel: "zhipu/glm-5.3",
    });

    engine.askTurnEnded({ siteId: "ask#2", ordinal: 1 }, "live-1");
    await expect(p1).resolves.toBe("live-1");
    engine.askTurnEnded({ siteId: "ask#3", ordinal: 1 }, "fixed");
    await expect(fix).resolves.toBe("fixed");
  });

  it("actor 更早就分歧：到达在飞位置时已不在同一条转录上，即便哈希相符也不续跑", async () => {
    // entries[0]'s instructions differ from the new script ⇒ seq 0 diverges; seq 2 happens to hash the same as inFlight but must not be revived because of that.
    const cache = cacheOf([
      [
        "planner",
        candidate([entry("旧的第一问", "r0", 4), entry("s1", "r1", 9)], {
          inFlight: inFlightOf("s2", 14),
        }),
      ],
    ]);
    const { engine, driver } = setup({ importedCache: cache });

    const planner = engine.createActor("actor#1", "planner");
    const p0 = engine.ask("ask#1", planner, "s0");
    const p1 = engine.ask("ask#2", planner, "s1");
    const p2 = engine.ask("ask#3", planner, "s2");
    await flush();

    expect(driver.sessionSeeds[0]).toBeUndefined();
    engine.askTurnEnded({ siteId: "ask#1", ordinal: 1 }, "live-0");
    await expect(p0).resolves.toBe("live-0");
    await flush();
    engine.askTurnEnded({ siteId: "ask#2", ordinal: 1 }, "live-1");
    await expect(p1).resolves.toBe("live-1");
    await flush();
    engine.askTurnEnded({ siteId: "ask#3", ordinal: 1 }, "live-2");
    await expect(p2).resolves.toBe("live-2");
    expect(driver.startAskCount()).toBe(3);
    expect(cachedSettles(driver)).toHaveLength(0);
  });

  describe("崩溃后 resume：据事件顺序精确复原「当时门开着吗」", () => {
    /** The amended run's original execution: seq 0 hit (a real row + no node-queued), seq 1 carried over (a live row + node-queued). */
    function recordedFirstLife(closeBeforeCarry: boolean): InMemoryJournalStore {
      const journal = new InMemoryJournalStore();
      journal.createRun({
        runId: RUN,
        caps: { maxConcurrency: 16 },
        spentTokens: 0,
        status: "running",
        resumedFrom: "run-a",
      });
      journal.putActor({
        runId: RUN,
        siteId: "actor#1",
        ordinal: 1,
        name: "planner",
        persona: { name: "planner" },
      });
      const row = (siteId: string, seq: number, instructions: string): NodeRecord => ({
        runId: RUN,
        siteId,
        ordinal: 1,
        kind: "ask",
        actorSiteId: "actor#1",
        actorOrdinal: 1,
        actorSeq: seq,
        inputHash: inputHash(instructions),
        status: "completed",
        result: `journal-${seq}`,
      });
      journal.putNode({ ...row("ask#1", 0, "s0"), messageBoundary: 4 });
      journal.putNode(row("ask#2", 1, "s1"));
      if (closeBeforeCarry) {
        journal.appendEvent(RUN, {
          type: "import-cache-closed",
          instance: { siteId: "world#1", ordinal: 1 },
          cause: "world-run",
        });
      }
      journal.appendEvent(RUN, {
        type: "node-queued",
        instance: { siteId: "ask#2", ordinal: 1 },
        kind: "ask",
        actor: { siteId: "actor#1", ordinal: 1 },
        actorSeq: 1,
      });
      return journal;
    }

    const carryCache = () =>
      cacheOf([["planner", candidate([entry("s0", "r0", 4)], { inFlight: inFlightOf("s1", 12) })]]);

    it("node-queued 早于关门事件 ⇒ 原次确实续跑过，resume 复原同一个种子", async () => {
      const { engine, driver } = setup({
        journal: recordedFirstLife(false),
        importedCache: carryCache(),
      });
      const planner = engine.createActor("actor#1", "planner");
      await expect(engine.ask("ask#1", planner, "s0")).resolves.toBe("journal-0");
      await expect(engine.ask("ask#2", planner, "s1")).resolves.toBe("journal-1");

      const p2 = engine.ask("ask#3", planner, "s2");
      await flush();
      expect(driver.startAskCount()).toBe(1);
      expect(driver.sessionSeeds[0]).toEqual({
        sourceSessionId: "sess-a",
        messageCount: 12,
        resolvedModel: "zhipu/glm-5.3",
      });
      engine.askTurnEnded({ siteId: "ask#3", ordinal: 1 }, "live-2");
      await expect(p2).resolves.toBe("live-2");
    });

    it("关门事件早于 node-queued ⇒ 原次没有续跑，resume 必须退回前缀边界（多抄一段就是串了转录）", async () => {
      const { engine, driver } = setup({
        journal: recordedFirstLife(true),
        importedCache: carryCache(),
      });
      const planner = engine.createActor("actor#1", "planner");
      await expect(engine.ask("ask#1", planner, "s0")).resolves.toBe("journal-0");
      await expect(engine.ask("ask#2", planner, "s1")).resolves.toBe("journal-1");

      const p2 = engine.ask("ask#3", planner, "s2");
      await flush();
      expect(driver.sessionSeeds[0]).toEqual({
        sourceSessionId: "sess-a",
        messageCount: 4,
        resolvedModel: "zhipu/glm-5.3",
      });
      engine.askTurnEnded({ siteId: "ask#3", ordinal: 1 }, "live-2");
      await expect(p2).resolves.toBe("live-2");
    });
  });
});

describe("导入缓存 — 转录早于本次派发的 ask 不记 worldToolCalls", () => {
  const TOUCHED = { tokens: 20, toolCalls: 4, turns: 2, worldToolCalls: 0 } as const;

  it("续跑的 ask：结算时落的 stats 去掉 worldToolCalls（计数器只数了本次派发的那几轮）", async () => {
    const cache = cacheOf([
      ["planner", candidate([], { inFlight: { inputHash: inputHash("s0"), messageBoundary: 6 } })],
    ]);
    const { engine, journal } = setup({ importedCache: cache });
    const planner = engine.createActor("actor#1", "planner");
    const p0 = engine.ask("ask#1", planner, "s0");
    await flush();

    engine.askStats({ siteId: "ask#1", ordinal: 1 }, { ...TOUCHED });
    engine.askTurnEnded({ siteId: "ask#1", ordinal: 1 }, "live-0");
    await expect(p0).resolves.toBe("live-0");

    expect(journal.getNode(RUN, "ask#1", 1)?.stats).toEqual({ tokens: 20, toolCalls: 4, turns: 2 });
  });

  it("续跑的 ask：结算之后才到的 stats 回填同样去掉 worldToolCalls", async () => {
    const cache = cacheOf([
      ["planner", candidate([], { inFlight: { inputHash: inputHash("s0"), messageBoundary: 6 } })],
    ]);
    const { engine, journal } = setup({ importedCache: cache });
    const planner = engine.createActor("actor#1", "planner");
    const p0 = engine.ask("ask#1", planner, "s0");
    await flush();

    engine.askTurnEnded({ siteId: "ask#1", ordinal: 1 }, "live-0");
    await expect(p0).resolves.toBe("live-0");
    engine.askStats({ siteId: "ask#1", ordinal: 1 }, { ...TOUCHED });

    expect(journal.getNode(RUN, "ask#1", 1)?.stats).toEqual({ tokens: 20, toolCalls: 4, turns: 2 });
  });

  it("resume 重新派发的 running 行：转录里已有上一轮的工具调用，同样不记 worldToolCalls", async () => {
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putActor({
      runId: RUN,
      siteId: "actor#1",
      ordinal: 1,
      name: "planner",
      persona: { name: "planner" },
    });
    journal.putNode({
      runId: RUN,
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 0,
      inputHash: inputHash("s0"),
      status: "running",
    });

    const { engine } = setup({ journal });
    const planner = engine.createActor("actor#1", "planner");
    const p0 = engine.ask("ask#1", planner, "s0");
    await flush();

    engine.askStats({ siteId: "ask#1", ordinal: 1 }, { ...TOUCHED });
    engine.askTurnEnded({ siteId: "ask#1", ordinal: 1 }, "live-0");
    await expect(p0).resolves.toBe("live-0");
    expect(journal.getNode(RUN, "ask#1", 1)?.stats).toEqual({ tokens: 20, toolCalls: 4, turns: 2 });
  });

  it("寻常的 live ask：worldToolCalls 照记（纯度判据不能被这条规则抹掉）", async () => {
    const { engine, journal } = setup();
    const planner = engine.createActor("actor#1", "planner");
    const p0 = engine.ask("ask#1", planner, "s0");
    await flush();

    engine.askStats({ siteId: "ask#1", ordinal: 1 }, { ...TOUCHED });
    engine.askTurnEnded({ siteId: "ask#1", ordinal: 1 }, "live-0");
    await expect(p0).resolves.toBe("live-0");
    expect(journal.getNode(RUN, "ask#1", 1)?.stats).toEqual({ ...TOUCHED });
  });
});

describe("导入缓存 — 用量沿 lineage 累计（docs/execution-engine.md「Usage across the lineage」）", () => {
  it("命中不加 token：前驱的账已在继承值里，条目的 stats 只拷到节点行；live 分歧才在其上累加", async () => {
    const cache = cacheOf([
      [
        "planner",
        candidate([
          entry("step 1", "r1", 4, { tokens: 100, toolCalls: 0, turns: 1 }),
          entry("step 2", "r2", 9, { tokens: 100, toolCalls: 0, turns: 1 }),
        ]),
      ],
    ]);
    const { engine, driver, journal } = setup({ importedCache: cache, inheritedTokens: 500 });
    const planner = engine.createActor("actor#1", "planner");
    await expect(engine.ask("ask#1", planner, "step 1")).resolves.toBe("r1");
    // After a hit the run value is unchanged and there is no second usage-updated (only the inherited value right after run-started).
    expect(journal.getRun(RUN)?.spentTokens).toBe(500);
    const hitStats = { tokens: 100, toolCalls: 0, turns: 1 };
    expect(journal.getNode(RUN, "ask#1", 1)?.stats).toEqual(hitStats);
    expect(driver.events.filter((event) => event.type === "usage-updated")).toEqual([
      { type: "usage-updated", spentTokens: 500 },
    ]);

    // Divergence: the second question's instructions changed → live; only its stats accumulate on top of 500.
    void engine.ask("ask#2", planner, "step 2, revised").catch(() => {});
    await flush();
    expect(driver.startAskCount()).toBe(1);
    engine.askStats({ siteId: "ask#2", ordinal: 1 }, { tokens: 30, toolCalls: 0, turns: 1 });
    expect(journal.getRun(RUN)?.spentTokens).toBe(530);
    expect(driver.events.at(-1)).toEqual({ type: "usage-updated", spentTokens: 530 });
    engine.stop("user");
  });
});
