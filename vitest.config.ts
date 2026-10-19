import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const processLifecycleTests = [
  "packages/services/test/processTreeTerminator.test.ts",
  "packages/services/test/zcodeAgentService.test.ts",
  "packages/services/test/zcodeAgentService.v4.test.ts",
  "packages/services/test/zcodeAgentProcessManager.test.ts",
  "packages/services/test/zcodeStdioTransport.test.ts",
];
const forkIsolatedTests = [
  ...processLifecycleTests,
  // electron-builder 下载 NSIS 时把进程 stdio 传给子进程，不能使用 threads 的虚拟 stdio。
  "packages/desktop/test/windowsInstallerCompile.test.ts",
  "packages/desktop/test/cdnPreloadScript.test.ts",
  "packages/desktop/test/desktopRuntimeEnv.test.ts",
  "packages/desktop/test/e2eDesktopBuildCache.test.ts",
  "packages/desktop/test/e2eSummarySpecCoverage.test.ts",
  "packages/desktop/test/migrateStableFeedScript.test.ts",
  "packages/desktop/test/pluginE2EAdmissionScripts.test.ts",
  "packages/desktop/test/uploadOssScript.test.ts",
  // 全量并发时真实心跳与嵌套构建会被调度延迟打穿；单独运行均通过，沿用串行组保留原时限。
  "packages/desktop/test/webRemoteControlTransport.test.ts",
  "packages/provider-node/test/builtin-provider-build.test.ts",
  "packages/provider-node/test/builtin-provider-test-config-sync.test.ts",
  "packages/server/test/remoteDeploy.test.ts",
  // Bugfix: 该集成测试会启动数百个真实 Git 子进程；放在普通 threads 并发组会让
  // macOS 进程启动队列饥饿，表现为 git init 长时间停在 dyld_start。
  "packages/services/test/gitService.test.ts",
  // Bugfix: checkpoint 集成测试同样会连续创建真实 Git 仓库；related 全量并发时会因
  // 子进程与磁盘调度饥饿超过 30 秒，隔离串行后保持聚焦运行时的真实耗时口径。
  "packages/services/test/gitCheckpointService.test.ts",
  "packages/services/test/mcpSyncService.test.ts",
  "packages/services/test/providerRuntimeResolver.test.ts",
  "packages/services/test/runtimeToolResolver.test.ts",
  // Bugfix（CI 稳定性）：该用例用真实 fs watcher 验证「目录被替换时丢弃在途读取」，
  // 边界约 5s。GitHub 2 核 runner 上并行 worker 的磁盘调度会打穿时限（本地 3/3 绿）。
  // 沿用本组先例：串行 fork 隔离，收敛调度竞争。
  "packages/services/test/subagentRuntimeConfig.test.ts",
  // 该集成测试会真实启动 tsx、Supervisor 与多代 Core；放在普通 threads 中时，
  // 并行 worker 的进程启动压力会让 15 秒 ready barrier 偶发超时。
  "packages/zcode-server-cli/test/runtimeUpdateIntegration.test.ts",
  // Bugfix: pdfjs-dist legacy build 在 threads worker 内偶发原生崩溃（0xC0000005，
  // 测试自身通过、worker 收尾时崩，会把整场全量跑拦腰截断）。隔离到 fork 池后崩溃
  // 波及面收敛到本文件，其余测试结果可完整收集；崩溃根因见
  // docs/windows-test-compatibility.md。
  "packages/ui/test/pdfJsCMapSupport.test.ts",
];

// Fork 的 node:test 用例（tsx --test，见 package.json test:node）不能用 vitest 收集，
// 必须从 unit include 中排除，否则报 "No test suite found"。
const forkNodeTestFiles = [
  "packages/services/test/botMessagesLocale.test.ts",
  "packages/services/test/branchMergeStatusService.test.ts",
  // session PR status node:test cases (mapping + service); run via test:node.
  "packages/services/test/sessionPullRequestMapping.test.ts",
  "packages/services/test/sessionPullRequestsService.test.ts",
  // Real-git + fake-gh integration over the host path; run via test:node.
  "packages/services/test/sessionPullRequestsIntegration.test.ts",
  // node:test cases run via test:node; excluded here so Vitest does not collect them.
  "packages/services/test/systemPromptService.test.ts",
  "packages/services/test/outputStyleService.test.ts",
  "packages/services/test/userInstructionsService.test.ts",
  // 该文件使用 node:test；随 test:node 运行，避免被 Vitest 二次收集。
  "packages/services/test/zcodeUpstreamBaseVersion.test.ts",
  // 语音听写的 node:test 用例（模型下载/转写/RPC 契约）；随 test:node 运行，避免被 Vitest 二次收集。
  "packages/services/test/voiceDictation.test.ts",
  "packages/services/test/voiceDictationRpc.test.ts",
  "packages/services/test/voiceModelLanguages.test.ts",
  "packages/services/test/voicePostProcess.test.ts",
  "packages/ui/test/voiceDictation.test.ts",
  "packages/ui/test/chatErrorResume.test.ts",
  "packages/ui/test/branchMergeStatusProbeRunner.test.ts",
  // session PR status prober node:test cases; run via test:node.
  "packages/ui/test/pullRequestStatusProbeRunner.test.ts",
  "packages/ui/test/i18nCatalogParity.test.ts",
  "packages/ui/test/intlPlural.test.ts",
  "packages/ui/test/localeContentCatalogs.test.ts",
  "packages/ui/test/localeFormatting.test.ts",
  "packages/ui/test/localeSettingsSchema.test.ts",
  "packages/ui/test/localeSupport.test.ts",
  "packages/ui/test/sessionThroughput.test.ts",
  "packages/ui/test/themeContrast.test.ts",
  "packages/ui/test/themeMigration.test.ts",
  "packages/ui/test/updateReleaseNotes.test.ts",
  "packages/ui/test/userInstructionsEditorModel.test.ts",
];

export default defineConfig({
  // 测试固定注入事件上报端点，使遥测上报链路在单测中可验证；真实构建由 scripts/build-time-config.mjs 决定。
  define: {
    __ZCODE_TELEMETRY_REPORT_ENDPOINT__: JSON.stringify("https://zcode.z.ai/api/v1/event/report"),
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "packages/ui/src"),
      "@desktop": resolve(__dirname, "packages/desktop/src"),
      "@web": resolve(__dirname, "packages/web/src"),
      // 间接 import desktopNetworkTelemetry 等的单测无需真实 ARMS；需 vi.fn 的用例在文件内 vi.mock 覆盖
      // Bugfix: 具体的 /browser 子路径必须排在包根别名前，否则会被根别名拼成不存在的 stub.ts/browser。
      "@arms/rum-electron/browser": resolve(
        __dirname,
        "packages/desktop/test/mocks/armsRumElectronStub.ts",
      ),
      "@arms/rum-electron": resolve(
        __dirname,
        "packages/desktop/test/mocks/armsRumElectronStub.ts",
      ),
    },
  },
  test: {
    setupFiles: ["./vitest.setup.ts"],
    // 修复原因：全量 run 的 stdout 会把**通过**测试里的 console 输出一并转发——services 层
    // 用 createServiceLogger 的用例在绿态下也要刷几千行多行日志，全量输出因此膨胀到
    // ~3.3MB，超过 CI/工作流门禁对单条命令 256KB 的 stdout 上限，导致门禁整条命令被判
    // 「无法执行」而非测试失败。passed-only 只隐藏通过测试的 console，失败用例的日志与
    // 断言 diff 原样保留（诊断能力不降级）；全绿时输出收敛到 ~140KB。
    silent: "passed-only",
    // 修复原因：全量单测并发跑 Git、zip、Electron 模块导入时，默认 5s 超时在低配或高负载机器上
    // 容易被提前打穿（spawn git 子进程、模块 import 变慢 → flaky 超时）；中断后的文件句柄清理在
    // Windows 上还会触发 EPERM/ENOTEMPTY。此前只给 Windows 放宽，但 macOS/Linux 低配机同样会因
    // 内存抖动（swap thrashing）拖慢 spawn，故统一降低并发并放宽超时。
    hookTimeout: 30_000,
    maxWorkers: 4,
    testTimeout: 30_000,
    // 修复原因：900+ 文件全部使用隔离 fork 时，macOS 会在尾部因连续创建进程而随机
    // 启动 worker 超时。普通用例使用 threads；会修改 cwd/umask、回收 POSIX 进程树或
    // 密集 spawn shell 的用例最后串行 fork，避免跨用例误杀、进程级状态竞争和系统
    // spawn 队列饥饿。
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: [
            "packages/*/test/**/*.test.ts",
            // 架构治理要求 managed 模块自带 contract.test.ts（见 architecture-policy.yaml），放在模块目录内。
            "packages/*/src/**/contract.test.ts",
            // Gen UI 目录回归位于源码旁，默认入口也必须执行，避免只在手动定向运行时生效。
            "packages/shared/src/node/genUiPaths.test.ts",
            "packages/services/src/gen-ui/**/*.test.ts",
            // CI runs only the root suite; pin upstream checksums of the shared CLI session DB here.
            "apps/zcode-cli/packages/adapters/tests/upstream-migration-checksum-pin.test.ts",
            "scripts/assert-safe-cua-helper-zip.test.mjs",
            "scripts/ci/ci-telemetry-keyword-guard.test.mjs",
          ],
          exclude: ["packages/desktop/test/e2e/**", ...forkIsolatedTests, ...forkNodeTestFiles],
          // macOS threads 全量运行可触发 V8 SIGSEGV；诊断时切换进程隔离，测试范围不变。
          pool: process.env.ZCODE_TEST_POOL === "forks" ? "forks" : "threads",
          maxWorkers: process.env.CI || process.env.ZCODE_TEST_POOL === "forks" ? 2 : 4,
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: "fork-isolated",
          include: forkIsolatedTests,
          pool: "forks",
          fileParallelism: false,
          maxWorkers: 1,
          sequence: { groupOrder: 1 },
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
    },
  },
});
