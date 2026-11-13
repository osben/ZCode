//! 测试夹具：经 rust-cli-fs 写临时目录里的文件（不直接用 std::fs，与 §4 的 IO 规则一致）；账号服务的
//! 替身（时钟、指向不可达地址的出口）。

use std::path::Path;
use std::sync::Arc;

use rust_cli_fs::{FileMode, ParentDir, TempName, WriteOptions};
use rust_cli_kernel_api::testing::ManualClock;
use rust_cli_net::{Egress, NetworkPolicy};

use crate::{AccountOrigins, AccountServices};

/// registry 的个人订阅与团队列表、权益：连不上任何服务。
pub(crate) async fn offline_account(
    credentials: crate::credentials::CredentialStore,
) -> crate::providers::Plans {
    let services = offline_services().await;
    let tokens = Arc::new(crate::token::ProjectTokens::new(
        services.egress.clone(),
        services.clock.clone(),
        services.origins.clone(),
    ));
    crate::providers::Plans {
        personal: Arc::new(crate::personal::PersonalPlans::new(
            services.egress.clone(),
            services.origins.clone(),
            tokens,
            credentials,
        )),
        teams: Arc::new(crate::team::TeamPlans::new(
            services.egress,
            services.origins,
        )),
    }
}

pub(crate) async fn write(path: &Path, bytes: impl AsRef<[u8]>) {
    let options = WriteOptions {
        mode: FileMode::Default,
        temp_name: TempName::Hidden,
        parent: ParentDir::Create,
        rename_retry: &[],
    };
    rust_cli_fs::atomic_write(path, bytes.as_ref(), options)
        .await
        .unwrap();
}

/// 读文本文件；不存在时为空。
pub(crate) async fn read_text(path: &Path) -> Option<String> {
    rust_cli_fs::read_optional(path)
        .await
        .unwrap()
        .map(|bytes| String::from_utf8(bytes).unwrap())
}

/// 不连任何服务的账号服务（地址指向不可达的本地端口）。
pub(crate) async fn offline_services() -> AccountServices {
    let origin = "http://127.0.0.1:9".to_owned();
    AccountServices {
        egress: Arc::new(Egress::new(NetworkPolicy::default()).await.unwrap()),
        clock: Arc::new(ManualClock::new(1_700_000_000_000)),
        origins: AccountOrigins {
            zcode_api: format!("{origin}/api/v1"),
            zai_api: origin.clone(),
            bigmodel_team_plans: format!("{origin}/coding-plan/team/plans"),
            bigmodel_api: origin,
            client_version: "0.0.0-test".to_owned(),
            usage_quota_url: None,
        },
    }
}

/// App 对照夹具（`scripts/rust-cli/team-plan-golden.mts` 生成，platform.md §7、§9）。
pub(crate) fn golden() -> serde_json::Value {
    serde_json::from_str(include_str!("../tests/fixtures/team-plan-golden.json")).unwrap()
}

/// 替身 cipher：`enc:v2:os:` 形状、可逆（反转字符），让桌面读取路径不经 Host 就能测（A11）。
pub(crate) struct ReversedCipher;

#[async_trait::async_trait]
impl rust_cli_kernel_api::provider::CredentialCipher for ReversedCipher {
    async fn encrypt(
        &self,
        plaintext: &str,
    ) -> Result<String, rust_cli_kernel_api::provider::CipherError> {
        let reversed: String = plaintext.chars().rev().collect();
        Ok(format!("enc:v2:os:0123456789abcdef01234567:{reversed}"))
    }

    async fn decrypt(
        &self,
        value: &str,
    ) -> Result<String, rust_cli_kernel_api::provider::CipherError> {
        match value.strip_prefix("enc:v2:os:0123456789abcdef01234567:") {
            Some(body) => Ok(body.chars().rev().collect()),
            None => Ok(value.to_owned()),
        }
    }
}

/// 替身 cipher：每次都说不可用（A12-A15）。
pub(crate) struct UnavailableCipher;

#[async_trait::async_trait]
impl rust_cli_kernel_api::provider::CredentialCipher for UnavailableCipher {
    async fn encrypt(
        &self,
        _plaintext: &str,
    ) -> Result<String, rust_cli_kernel_api::provider::CipherError> {
        Err(rust_cli_kernel_api::provider::CipherError::Unavailable {
            reason: "credential storage unavailable",
        })
    }

    async fn decrypt(
        &self,
        _value: &str,
    ) -> Result<String, rust_cli_kernel_api::provider::CipherError> {
        Err(rust_cli_kernel_api::provider::CipherError::Unavailable {
            reason: "credential storage unavailable",
        })
    }
}

/// 替身 cipher：开关控制是否说不可用，测试“上一次结果保留”（A14）。
pub(crate) struct SwitchCipher {
    pub down: std::sync::atomic::AtomicBool,
}

#[async_trait::async_trait]
impl rust_cli_kernel_api::provider::CredentialCipher for SwitchCipher {
    async fn encrypt(
        &self,
        plaintext: &str,
    ) -> Result<String, rust_cli_kernel_api::provider::CipherError> {
        if self.down.load(std::sync::atomic::Ordering::SeqCst) {
            return UnavailableCipher.encrypt(plaintext).await;
        }
        ReversedCipher.encrypt(plaintext).await
    }

    async fn decrypt(
        &self,
        value: &str,
    ) -> Result<String, rust_cli_kernel_api::provider::CipherError> {
        if self.down.load(std::sync::atomic::Ordering::SeqCst) {
            return UnavailableCipher.decrypt(value).await;
        }
        ReversedCipher.decrypt(value).await
    }
}
