//! 凭据加解密委托 Host（specs/fork-rust-credential-cipher.md）：反向请求 `interaction/requestCredentialCipher`，
//! 密钥在 Electron Main。限制与回复形状照 Node `validation.ts` 与 `bridge.ts`；失败只映射成静态原因，不带 Host 的消息。

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use rust_cli_kernel_api::provider::{CipherError, CredentialCipher};
use serde_json::json;

use crate::context::Context;
use crate::inbound::Inbound;

pub const REQUEST: &str = "interaction/requestCredentialCipher";
/// 反向请求的时限：Host 可能丢掉启动期间到达的请求（它在 spawn 返回后才挂上 `onRequest`），首次系统密钥库授权也可能
/// 等待用户。时限只是兜底，不替代回复；超时即 Unavailable，不重试（specs/fork-rust-credential-cipher.md，Bridge wire contract）。
const LIMIT: Duration = Duration::from_secs(300);
/// Node `CREDENTIAL_PLAINTEXT_MAX_BYTES`：明文按 UTF-8 字节数。
const PLAINTEXT_MAX_BYTES: usize = 1_048_576;
/// Node `CREDENTIAL_CIPHERTEXT_MAX_CHARS`：zod 的 `.max` 数的是 UTF-16 码元。
const CIPHERTEXT_MAX_UNITS: usize = 1_398_232;

#[derive(Clone, Copy)]
enum Operation {
    Encrypt,
    Decrypt,
}

impl Operation {
    fn name(self) -> &'static str {
        match self {
            Self::Encrypt => "encrypt",
            Self::Decrypt => "decrypt",
        }
    }

    /// 回复里的失败如何归类：解不开是 Decrypt，加密的输入不合法是 Encrypt。
    fn invalid(self, reason: &'static str) -> CipherError {
        match self {
            Self::Encrypt => CipherError::Encrypt { reason },
            Self::Decrypt => CipherError::Decrypt { reason },
        }
    }
}

/// 经 Host 加解密凭据（桌面 app-server）。
pub struct HostCredentialCipher {
    context: Arc<Context>,
    limit: Duration,
}

impl HostCredentialCipher {
    pub fn new(context: Arc<Context>) -> Self {
        Self {
            context,
            limit: LIMIT,
        }
    }

    /// 测试用：把时限换成短的，观察超时。
    #[cfg(test)]
    pub(crate) fn with_limit(context: Arc<Context>, limit: Duration) -> Self {
        Self { context, limit }
    }

    async fn call(&self, operation: Operation, value: &str) -> Result<String, CipherError> {
        // 超限的输入不发出去：Host 的 schema 会拒绝，等同于失败。
        match operation {
            Operation::Encrypt if value.len() > PLAINTEXT_MAX_BYTES => {
                return Err(operation.invalid("plaintext exceeds the credential size limit"));
            }
            Operation::Decrypt if utf16_len(value) > CIPHERTEXT_MAX_UNITS => {
                return Err(operation.invalid("stored value exceeds the credential size limit"));
            }
            _ => {}
        }
        let request_id = request_id();
        let params = json!({
            "requestId": request_id,
            "operation": operation.name(),
            "value": value,
        });
        // The wait for the Host's attach acknowledgement is part of the same bound (F1). `ready` records, inside
        // the bound, that the wait for the acknowledgement ended, so an acknowledgement that lands just after the timeout
        // does not change which bound is named.
        let ready = AtomicBool::new(false);
        let answer = tokio::time::timeout(self.limit, async {
            if self.context.host_ready().await == Some(false) {
                return Err(unavailable("the host has no credential cipher"));
            }
            ready.store(true, Ordering::SeqCst);
            // JSON-RPC 错误（例如 -32602）与连接关闭都是传输失败；原始消息不向上传。
            self.context
                .peer
                .request(REQUEST, &params)
                .await
                .map_err(|_| unavailable("the credential cipher request failed"))
        })
        .await;
        let result = match answer {
            Err(_) if !ready.load(Ordering::SeqCst) => {
                return Err(unavailable(
                    "the host did not acknowledge the attach in time",
                ));
            }
            Err(_) => return Err(unavailable("the credential cipher did not reply in time")),
            Ok(result) => result?,
        };
        Inbound::get()
            .reply(REQUEST, &result)
            .map_err(|_| unavailable("the credential cipher reply is invalid"))?;
        if result["requestId"] != request_id.as_str() {
            return Err(unavailable(
                "the credential cipher reply does not match the request",
            ));
        }
        let outcome = &result["result"];
        if outcome["ok"] == true {
            let value = outcome["value"].as_str().unwrap_or_default();
            let within = match operation {
                Operation::Encrypt => utf16_len(value) <= CIPHERTEXT_MAX_UNITS,
                Operation::Decrypt => value.len() <= PLAINTEXT_MAX_BYTES,
            };
            if !within {
                return Err(unavailable(
                    "the credential cipher reply exceeds the size limit",
                ));
            }
            return Ok(value.to_owned());
        }
        Err(match outcome["error"]["code"].as_str() {
            Some("ZCODE_CREDENTIAL_DECRYPT_FAILED") => {
                operation.invalid("the stored credential could not be decrypted")
            }
            Some("CREDENTIAL_CIPHER_INVALID_PAYLOAD") => {
                operation.invalid("the credential cipher rejected the payload")
            }
            Some("CREDENTIAL_SECURE_STORAGE_UNAVAILABLE") => {
                unavailable("the system credential storage is unavailable")
            }
            _ => unavailable("the credential cipher reported an unknown error"),
        })
    }
}

fn unavailable(reason: &'static str) -> CipherError {
    CipherError::Unavailable { reason }
}

/// JavaScript 的字符串长度（UTF-16 码元）。
fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

/// 随机 v4 uuid（zod `.uuid()` 要求）。`uuid::Uuid::new_v4` 被 clippy 禁用（统一经随机源），这里用 crate 的随机源
/// 拼出 v4：版本位与变体位照 RFC 4122 设置。请求 ID 只用来对回复，不是秘密。
fn request_id() -> String {
    let mut bytes = [0u8; 16];
    bytes[..8].copy_from_slice(&rust_cli_base::random::u64().to_be_bytes());
    bytes[8..].copy_from_slice(&rust_cli_base::random::u64().to_be_bytes());
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

#[async_trait]
impl CredentialCipher for HostCredentialCipher {
    async fn encrypt(&self, plaintext: &str) -> Result<String, CipherError> {
        self.call(Operation::Encrypt, plaintext).await
    }

    async fn decrypt(&self, value: &str) -> Result<String, CipherError> {
        self.call(Operation::Decrypt, value).await
    }
}

#[cfg(test)]
#[path = "cipher_tests.rs"]
mod tests;
