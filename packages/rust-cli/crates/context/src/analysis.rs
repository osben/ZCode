//! `/context` 的上下文分析（docs/specs/rust-cli/context-usage.md §2、§3）：system prompt 的段落、规则文件、
//! skill 清单行与 MCP instructions。用与 `build` 相同的事实与清单；只读，不进规则缓存。

use rust_cli_kernel_api::incognito::IncognitoKey;
use rust_cli_kernel_api::listing::ListingEntry;
use rust_cli_kernel_api::message::Message;
use rust_cli_kernel_api::orchestration::{ContextRequest, OrchestrationError};

use crate::render::since_boundary;
use crate::system::{PromptFacts, sections};
use crate::{PromptAssembler, session_context};

/// 一个已加载的规则文件（memory file）。`kind` 是 `User`、`Project` 等。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryFile {
    pub path: String,
    pub kind: &'static str,
    pub content: String,
}

/// system prompt 的一段与它在 `/context` 明细里的名字（固定的英文，context-usage.md §3.1）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptSection {
    pub name: &'static str,
    pub text: String,
}

impl PromptSection {
    pub(crate) fn new(name: &'static str, text: String) -> Self {
        Self { name, text }
    }
}

/// 分析的结果。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Analysis {
    /// system prompt 的段落；git 仓库时最后一段是 gitStatus（`Git status`）。
    pub sections: Vec<PromptSection>,
    /// 没有 `paths` 条件的规则文件（启动时加载的那些，含 AutoMem 的 MEMORY.md）。
    pub memory_files: Vec<MemoryFile>,
    /// skill 清单的行（与 `skill_listing` attachment 相同）。
    pub skills: Vec<ListingEntry>,
    pub mcp_instructions: Vec<ListingEntry>,
}

impl PromptAssembler {
    /// `history` 是会话的完整历史（没有会话时为空）；只看最后一个压缩边界之后的部分。
    pub async fn analysis(
        &self,
        request: &ContextRequest,
        history: &[Message],
    ) -> Result<Analysis, OrchestrationError> {
        let window = since_boundary(history);
        let listings = self.ports.listings.listings_for(request, window).await?;
        let facts = PromptFacts {
            surface: self.config.surface,
            system_turns: crate::system::facts_system_turns(request),
            tool_names: &request.tool_names,
            has_skills: !listings.skills.is_empty(),
            memory_dir: self.memory_dir(request),
            output_style: self.output_style(request),
            custom: self.prompt_overrides(request).0,
            append: self.prompt_overrides(request).1,
            token_budget: self.config.token_budget,
            incognito: self.incognito.get(&request.session),
        };
        let mut analysis = Analysis {
            sections: sections(&facts),
            skills: listings.skills,
            mcp_instructions: self.ports.listings.mcp_instructions(request).await?,
            ..Analysis::default()
        };
        // 执行环境给不出事实时没有规则文件与 gitStatus（与 `build` 相同）。
        let Ok(env_facts) = self.ports.info.facts(&request.workspace).await else {
            return Ok(analysis);
        };
        let git = self.ports.git.as_ref();
        // `--system-prompt` 时没有 git 状态（与 `build` 相同，cli-args.md §4.2）。Fork: nor without `environment`.
        if self.prompt_overrides(request).0.is_none()
            && !self.excludes(request, IncognitoKey::Environment)
            && let Some(git) =
                session_context::git_section(git, &request.workspace, &env_facts, window).await
        {
            analysis
                .sections
                .push(PromptSection::new("Git status", git));
        }
        // Fork: the same gated read as `build`, so `/context` never lists files an incognito profile excludes.
        analysis.memory_files = self
            .load_rule_files(request, &env_facts)
            .await
            .into_iter()
            .filter(|file| file.globs.is_none())
            .map(|file| MemoryFile {
                path: file.path,
                kind: file.kind.name(),
                content: file.content,
            })
            .collect();
        Ok(analysis)
    }
}
