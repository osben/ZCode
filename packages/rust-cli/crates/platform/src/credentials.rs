// 复制自 apps/zcode-host/crates/account/src/account/credential.rs（1f0bfd1b71）的 `CredentialCipher` 与读取
// 部分。改动：文件经 rust-cli-fs 读写；密钥构造失败返回错误而不是 panic；密钥材料（平台、home、用户名）
// 由入口给出，不在这里读进程环境。写入取 Node `shared-credentials.ts` 的 `mutateRawCredentialRecord`
// （33a9541140）：目录锁内读改写，原子写回（platform.md §5.5）。
//! 共享凭据 `credentials.json`（docs/specs/rust-cli/platform.md §5.1）。
//!
//! 与 Node Host、Node CLI 共用：值用 AES-256-GCM 加密成 `enc:v1:<iv>.<tag>.<ciphertext>`（无填充 base64url），
//! 密钥是 `sha256(secret)`，secret 是 `ZCODE_CREDENTIAL_SECRET`，没有时是
//! `zcode-credential-fallback:<platform>:<homedir>:<username>`（Node `resolveCredentialSecret`）。
//! 不缓存文件内容：每次读取都以磁盘为准。写入在与 Node 同形的目录锁内读改写（[`CredentialStore::mutate`]）。

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use async_trait::async_trait;
use base64::Engine;
use base64::alphabet;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use ring::aead::{AES_256_GCM, Aad, LessSafeKey, NONCE_LEN, Nonce, UnboundKey};
use ring::rand::{SecureRandom, SystemRandom};
use rust_cli_base::secret::RedactedString;
use rust_cli_fs::{FileMode, LockOptions, ParentDir, TempName, WriteOptions};
use rust_cli_kernel_api::provider::{CipherError, CredentialCipher};
use rust_cli_paths::StoragePath;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

const ENCRYPTED_VALUE_PREFIX: &str = "enc:v1:";
/// 桌面（Main 持有密钥）写入的格式。standalone 读不了它：只能报不可用，不能当明文（specs/fork-rust-credential-cipher.md）。
const DESKTOP_ENCRYPTED_PREFIX: &str = "enc:v2:";
const TAG_BYTES: usize = 16;
/// 密文 `iv.tag.data` 的段数。
const ENCRYPTED_PARTS: usize = 3;

/// Node `atomicWritePrivateTextFile`：隐藏临时文件、0600、rename 被占用时的重试间隔。
pub(crate) const PRIVATE_WRITE: WriteOptions = WriteOptions {
    mode: FileMode::Private,
    temp_name: TempName::Hidden,
    parent: ParentDir::Create,
    rename_retry: rust_cli_fs::NODE_RENAME_RETRY,
};

/// Node `Buffer.from(raw, "base64url")` 接受有无填充两种写法；输出始终无填充。
pub(crate) const BASE64URL: GeneralPurpose = GeneralPurpose::new(
    &alphabet::URL_SAFE,
    GeneralPurposeConfig::new()
        .with_encode_padding(false)
        .with_decode_padding_mode(DecodePaddingMode::Indifferent)
        .with_decode_allow_trailing_bits(true),
);

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CredentialError {
    /// 加解密失败或存储不可用（[`CipherError`]）：不是登录失效，调用方不能据此清除登录状态。
    #[error(transparent)]
    Cipher(#[from] CipherError),
    #[error("ZCode credentials are corrupt: {0}")]
    Corrupt(String),
    #[error("unable to read ZCode credentials: {0}")]
    Io(String),
    #[error("unable to write ZCode credentials: {0}")]
    Write(String),
}

/// 生成凭据密钥的材料（入口在启动时读好传入）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialSecret {
    /// `ZCODE_CREDENTIAL_SECRET`（已去掉首尾空白，空值视为没有）。
    pub explicit: Option<RedactedString>,
    /// Node `os.platform()`：darwin / linux / win32。
    pub platform: String,
    /// Node `os.homedir()`。
    pub home: String,
    /// Node `os.userInfo().username`。
    pub username: String,
}

impl CredentialSecret {
    /// Node `legacyKeyCandidates` 的 fallback：`zcode-credential-fallback:<platform>:<homedir>:<username>`。
    pub(crate) fn fallback(&self) -> String {
        format!(
            "zcode-credential-fallback:{}:{}:{}",
            self.platform, self.home, self.username
        )
    }

    /// Node `defaultCredentialSecret`。
    fn derive(&self) -> String {
        match &self.explicit {
            Some(secret) if !secret.expose().trim().is_empty() => secret.expose().trim().to_owned(),
            _ => format!(
                "zcode-credential-fallback:{}:{}:{}",
                self.platform, self.home, self.username
            ),
        }
    }
}

/// v1 编解码（`enc:v1:`，Node `credential-cipher.ts`）：standalone 本地用，桌面不用它。
#[derive(Clone)]
pub(crate) struct V1Codec {
    key: [u8; 32],
}

impl V1Codec {
    pub fn new(secret: &CredentialSecret) -> Self {
        Self {
            key: Sha256::digest(secret.derive().as_bytes()).into(),
        }
    }

    fn sealing_key(&self) -> Result<LessSafeKey, CipherError> {
        UnboundKey::new(&AES_256_GCM, &self.key)
            .map(LessSafeKey::new)
            .map_err(|_| CipherError::Encrypt {
                reason: "AES-256 key length",
            })
    }

    /// 用随机 IV 加密（Node `randomBytes(12)`）。
    #[expect(
        clippy::disallowed_methods,
        reason = "platform 是加密强度随机数的入口：凭据的 IV（README §4 的随机类别，F58）"
    )]
    pub fn encrypt(&self, value: &str) -> Result<String, CipherError> {
        let mut iv = [0u8; NONCE_LEN];
        SystemRandom::new()
            .fill(&mut iv)
            .map_err(|_| CipherError::Encrypt {
                reason: "random IV",
            })?;
        self.encrypt_with_iv(value, iv)
    }

    /// 指定 IV 的加密：测试用它证明密文格式与 Node 逐字节相同。
    pub fn encrypt_with_iv(&self, value: &str, iv: [u8; NONCE_LEN]) -> Result<String, CipherError> {
        let mut data = value.as_bytes().to_vec();
        let tag = self
            .sealing_key()?
            .seal_in_place_separate_tag(Nonce::assume_unique_for_key(iv), Aad::empty(), &mut data)
            .map_err(|_| CipherError::Encrypt {
                reason: "AES-GCM seal",
            })?;
        Ok(format!(
            "{ENCRYPTED_VALUE_PREFIX}{}.{}.{}",
            BASE64URL.encode(iv),
            BASE64URL.encode(tag.as_ref()),
            BASE64URL.encode(&data)
        ))
    }

    /// 解密 `enc:v1:`；没有前缀的旧值原样返回（Node 相同）。
    pub fn decrypt(&self, value: &str) -> Result<String, CipherError> {
        let Some(payload) = value.strip_prefix(ENCRYPTED_VALUE_PREFIX) else {
            return Ok(value.to_owned());
        };
        let parts: Vec<&str> = payload.split('.').collect();
        if parts.len() != ENCRYPTED_PARTS || parts.iter().any(|part| part.is_empty()) {
            return Err(CipherError::Decrypt {
                reason: "密文格式非法",
            });
        }
        let decode = |raw: &str| BASE64URL.decode(raw).unwrap_or_default();
        let (iv, tag, cipher) = (decode(parts[0]), decode(parts[1]), decode(parts[2]));
        let iv: [u8; NONCE_LEN] = iv.try_into().map_err(|_| CipherError::Decrypt {
            reason: "IV 长度非法",
        })?;
        if tag.len() != TAG_BYTES {
            return Err(CipherError::Decrypt {
                reason: "AuthTag 长度非法",
            });
        }
        let mut data = cipher;
        data.extend_from_slice(&tag);
        let key = self.sealing_key().map_err(|_| CipherError::Decrypt {
            reason: "密钥不匹配或密文已损坏",
        })?;
        let plain = key
            .open_in_place(Nonce::assume_unique_for_key(iv), Aad::empty(), &mut data)
            .map_err(|_| CipherError::Decrypt {
                reason: "密钥不匹配或密文已损坏",
            })?;
        Ok(String::from_utf8_lossy(plain).into_owned())
    }
}

/// 本地 v1 编解码（`Platform::new`）：examples and tests only. Standalone entry points use [`crate::SystemCipher`]
/// (specs/fork-rust-credential-cipher.md F4).
pub struct LocalCipher {
    codec: V1Codec,
}

impl LocalCipher {
    pub fn new(secret: &CredentialSecret) -> Self {
        Self {
            codec: V1Codec::new(secret),
        }
    }
}

#[async_trait]
impl CredentialCipher for LocalCipher {
    async fn encrypt(&self, plaintext: &str) -> Result<String, CipherError> {
        self.codec.encrypt(plaintext)
    }

    async fn decrypt(&self, value: &str) -> Result<String, CipherError> {
        // A2: a desktop-encrypted value is not plaintext; this v1-only cipher cannot read it.
        if value.starts_with(DESKTOP_ENCRYPTED_PREFIX) {
            return Err(CipherError::Unavailable {
                reason: "standalone agent cannot read desktop-encrypted (v2) credentials yet",
            });
        }
        // A3: any other `enc:` prefix this build does not understand is an error, never plaintext.
        if value.starts_with("enc:") && !value.starts_with(ENCRYPTED_VALUE_PREFIX) {
            return Err(CipherError::Decrypt {
                reason: "未知的加密格式",
            });
        }
        self.codec.decrypt(value)
    }
}

/// 一次读取的凭据记录：值按需解密（每次取值都经 cipher，桌面时经 Host）。
pub(crate) struct Credentials {
    record: Map<String, Value>,
    cipher: Arc<dyn CredentialCipher>,
}

impl Credentials {
    /// 一个键的明文；没有这个键时为空。解密失败是错误，不是“没有”。
    pub async fn get(&self, key: &str) -> Result<Option<RedactedString>, CredentialError> {
        match self.record.get(key).and_then(Value::as_str) {
            None => Ok(None),
            Some(raw) => Ok(Some(RedactedString::new(self.cipher.decrypt(raw).await?))),
        }
    }

    /// 写入一个已经加密好的值（[`CredentialStore::seal`]，在拿文件锁之前加密：Node 的顺序）。
    pub fn put_sealed(&mut self, key: &str, sealed: String) {
        self.record.insert(key.to_owned(), Value::String(sealed));
    }

    /// 删掉一个键（不需要解密）。
    pub fn remove(&mut self, key: &str) {
        self.record.shift_remove(key);
    }

    /// 明文去掉首尾空白后非空才算有。解密失败是错误：调用方不能把它当成未登录。
    pub async fn present(&self, key: &str) -> Result<Option<RedactedString>, CredentialError> {
        Ok(self.get(key).await?.and_then(|value| {
            let trimmed = value.expose().trim().to_owned();
            (!trimmed.is_empty()).then(|| RedactedString::new(trimmed))
        }))
    }
}

/// `credentials.json` 的读取方。
#[derive(Clone)]
pub(crate) struct CredentialStore {
    file: StoragePath,
    cipher: Arc<dyn CredentialCipher>,
    /// 上一次读取是否因存储不可用而失败：只在状态变化时写日志（warn 一次、恢复 info 一次）。
    unreadable: Arc<AtomicBool>,
}

impl CredentialStore {
    /// 本地 v1 编解码的存储（standalone 与测试；桌面用 [`Self::with_cipher`]）。
    #[cfg(test)]
    pub fn new(file: StoragePath, secret: &CredentialSecret) -> Self {
        Self::with_cipher(file, Arc::new(LocalCipher::new(secret)))
    }

    pub fn with_cipher(file: StoragePath, cipher: Arc<dyn CredentialCipher>) -> Self {
        Self {
            file,
            cipher,
            unreadable: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn file(&self) -> &StoragePath {
        &self.file
    }

    /// 加密一个值（在拿文件锁之前调用，Node `mutateRawCredentialRecord` 的顺序）。
    pub async fn seal(&self, value: &str) -> Result<String, CredentialError> {
        Ok(self.cipher.encrypt(value).await?)
    }

    /// 在目录锁内读改写（Node `mutateRawCredentialRecord`）：持锁读文件，`change` 改记录，原子写回
    /// `JSON.stringify(record, null, 2)` 加换行。文件损坏时不写（不能把别的进程的凭据全部抹掉）；`change`
    /// 失败（包括存储不可用）时也不写。
    pub async fn mutate<T>(
        &self,
        change: impl AsyncFnOnce(&mut Credentials) -> Result<T, CredentialError>,
    ) -> Result<T, CredentialError> {
        let file = self.file.as_path();
        let result = rust_cli_fs::with_file_lock(file, &LockOptions::default(), async || {
            let mut credentials = self.read().await?;
            let result = change(&mut credentials).await?;
            let mut text = serde_json::to_string_pretty(&credentials.record)
                .map_err(|error| CredentialError::Write(error.to_string()))?;
            text.push('\n');
            rust_cli_fs::atomic_write(file, text.as_bytes(), PRIVATE_WRITE)
                .await
                .map_err(|error| CredentialError::Write(format!("{}: {error}", file.display())))?;
            Ok(result)
        })
        .await;
        self.note(&result);
        result
    }

    /// 读整个文件。不存在时是空记录；不是“值全为字符串的对象”时报损坏（Node 拒绝把它当空 store）。
    pub async fn read(&self) -> Result<Credentials, CredentialError> {
        let bytes = rust_cli_fs::read_optional(self.file.as_path())
            .await
            .map_err(|error| {
                CredentialError::Io(format!("{}: {error}", self.file.as_path().display()))
            })?;
        let record = match bytes {
            None => Map::new(),
            Some(bytes) => match serde_json::from_slice::<Value>(&bytes) {
                Ok(Value::Object(record)) if record.values().all(Value::is_string) => record,
                _ => {
                    return Err(CredentialError::Corrupt(
                        self.file.as_path().display().to_string(),
                    ));
                }
            },
        };
        Ok(Credentials {
            record,
            cipher: self.cipher.clone(),
        })
    }

    /// 记下一次凭据操作的结果：存储不可用（或解密失败）时写一条 warn，只写状态变化的那一次；恢复时写一条 info。
    /// 日志只带静态原因，不带值、密钥或 Host 的消息。
    pub fn note<T>(&self, result: &Result<T, CredentialError>) {
        match result {
            Err(error) => self.note_error(error),
            Ok(_) => self.note_ok(),
        }
    }

    /// 一次读取成功：之前不可读的话写一条 info（恢复）。
    pub fn note_ok(&self) {
        if self.unreadable.swap(false, Ordering::Relaxed) {
            tracing::info!("ZCode credentials can be read again");
        }
    }

    /// 见 [`Self::note`]：只对存储不可用与解密失败记日志，其他错误（损坏、写入）由调用方记。
    pub fn note_error(&self, error: &CredentialError) {
        if let CredentialError::Cipher(error) = error
            && !self.unreadable.swap(true, Ordering::Relaxed)
        {
            tracing::warn!(
                reason = cipher_reason(error),
                "ZCode credentials could not be read; logged-in state is kept"
            );
        }
    }
}

/// 错误的静态原因（日志与用户可见文案用，不含值）。
pub(crate) fn cipher_reason(error: &CipherError) -> &'static str {
    match error {
        CipherError::Decrypt { reason }
        | CipherError::Encrypt { reason }
        | CipherError::Unavailable { reason } => reason,
    }
}

/// 凭据读取失败的静态原因；损坏与 IO 错误没有 cipher 原因，统一用“凭据文件不可读”。
pub(crate) fn unreadable_reason(error: &CredentialError) -> &'static str {
    match error {
        CredentialError::Cipher(error) => cipher_reason(error),
        CredentialError::Corrupt(_) | CredentialError::Io(_) | CredentialError::Write(_) => {
            "credentials file is unreadable"
        }
    }
}

impl From<std::io::Error> for CredentialError {
    /// 目录锁的错误（超时、权限）。
    fn from(error: std::io::Error) -> Self {
        Self::Write(error.to_string())
    }
}

#[cfg(test)]
#[path = "credentials_tests.rs"]
mod tests;
