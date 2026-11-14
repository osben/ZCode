//! Coding Plan 的账号体系（Provider 配置的 `accountType`，docs/specs/rust-cli/platform.md §5）。平台层按它换令牌与登录，
//! TUI 的登录视图按它列选项与写文字；名字只定义在这里（F133，审查 E7：以前在 platform，TUI 为它依赖整个 platform）。

/// Coding Plan 的账号体系（`accountType`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Family {
    Zai,
    Bigmodel,
}

impl Family {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Zai => "zai",
            Self::Bigmodel => "bigmodel",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "zai" => Some(Self::Zai),
            "bigmodel" => Some(Self::Bigmodel),
            _ => None,
        }
    }

    /// 显示名（Node `providerName`）：目录项的供应商名（platform.md §9.3）与 TUI 的登录文字都用它，中英文相同。
    /// F58：以前 platform（`account::vendor`）与 tui（`i18n_account::provider_name`）各写一份。
    pub fn display_name(self) -> &'static str {
        match self {
            Self::Zai => "Z.AI",
            Self::Bigmodel => "BigModel",
        }
    }
}

/// Fork: the builtin ChatGPT Plan (SIWC) provider id. It is only the template rule: the registry publishes one entry
/// per signed-in account, `account:chatgpt-plan:<accountKey>` (specs/fork-rust-chatgpt-plan.md, Node
/// `BUILTIN_MODEL_PROVIDER_IDS.chatgptPlan`).
pub const CHATGPT_PLAN_PROVIDER: &str = "account:chatgpt-plan";

/// Fork: Node `isChatGptPlanAccountKey`: 16 lowercase hex characters (a `sha256(sub)` prefix) after trimming.
pub fn is_chatgpt_plan_account_key(key: &str) -> bool {
    let key = key.trim();
    key.len() == 16
        && key
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// Fork: Node `buildChatGptPlanAccountProviderId`: the per-account entry id (not the template id
/// [`CHATGPT_PLAN_PROVIDER`]). Node throws on an invalid key; callers pass keys already validated.
pub fn chatgpt_plan_account_provider(key: &str) -> String {
    debug_assert!(
        is_chatgpt_plan_account_key(key),
        "invalid ChatGPT Plan account key"
    );
    format!("{CHATGPT_PLAN_PROVIDER}:{}", key.trim())
}

/// Fork: Node `parseChatGptPlanAccountProviderId`: the account key of a per-account entry, None for any other id
/// (the base id included).
pub fn chatgpt_plan_account(provider: &str) -> Option<&str> {
    let key = provider
        .trim()
        .strip_prefix(CHATGPT_PLAN_PROVIDER)?
        .strip_prefix(':')?
        .trim();
    is_chatgpt_plan_account_key(key).then_some(key)
}

#[cfg(test)]
#[path = "account_tests.rs"]
mod tests;
