//! 经 Host 加解密凭据（specs/fork-rust-credential-cipher.md，A4-A10）：反向请求的参数、回复的校验与错误映射。
use std::sync::Arc;
use std::time::Duration;

use rust_cli_base::TaskScope;
use rust_cli_kernel_api::provider::{CipherError, CredentialCipher};
use rust_cli_kernel_api::testing::FixedClock;
use rust_cli_protocol_core::connection::{self, Options, Reply, Service};
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, Lines, duplex};

use super::*;

struct Nothing;

#[async_trait::async_trait]
impl Service for Nothing {
    async fn request(&self, method: &str, _params: Value) -> Result<Reply, RpcError> {
        Err(RpcError::method_not_found(method))
    }
}

/// 假 Host：读 agent 的反向请求，回复由测试决定。
struct Host {
    write: DuplexStream,
    lines: Lines<BufReader<DuplexStream>>,
}

impl Host {
    async fn next(&mut self) -> Value {
        let line = tokio::time::timeout(Duration::from_secs(5), self.lines.next_line())
            .await
            .expect("the agent sent a request")
            .unwrap()
            .expect("the connection is open");
        serde_json::from_str(&line).unwrap()
    }

    async fn answer(&mut self, request: &Value, result: Value) {
        let reply = json!({"id": request["id"], "result": result});
        self.write
            .write_all(format!("{reply}\n").as_bytes())
            .await
            .unwrap();
    }

    async fn fail(&mut self, request: &Value, code: i64, message: &str) {
        let reply = json!({"id": request["id"], "error": {"code": code, "message": message}});
        self.write
            .write_all(format!("{reply}\n").as_bytes())
            .await
            .unwrap();
    }
}

fn connect(limit: Duration) -> (HostCredentialCipher, Host, TaskScope) {
    let scope = TaskScope::root("test", |_| {});
    let (host_out, agent_in) = duplex(1 << 20);
    let (agent_out, host_in) = duplex(1 << 20);
    let (peer, _writer) = connection::start(agent_out, &scope.spawner(), Options::default());
    drop(scope.spawner().spawn(
        "serve",
        connection::serve(
            BufReader::new(agent_in),
            peer.clone(),
            Arc::new(Nothing),
            scope.spawner(),
            Options::default(),
        ),
    ));
    let context = Arc::new(Context::new(peer, Arc::new(FixedClock(1))));
    let cipher = HostCredentialCipher::with_limit(context, limit);
    let host = Host {
        write: host_out,
        lines: BufReader::new(host_in).lines(),
    };
    (cipher, host, scope)
}

const LIMIT: Duration = Duration::from_secs(5);

/// v4 uuid：36 字符，第 15 位是 4，第 20 位是 8、9、a、b 之一。
fn is_v4_uuid(text: &str) -> bool {
    let bytes = text.as_bytes();
    text.len() == 36
        && bytes[8] == b'-'
        && bytes[13] == b'-'
        && bytes[18] == b'-'
        && bytes[23] == b'-'
        && bytes[14] == b'4'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
        && text
            .chars()
            .filter(|c| *c != '-')
            .all(|c| c.is_ascii_hexdigit())
}

#[tokio::test]
async fn encrypt_and_decrypt_round_trip_through_the_host() {
    let (cipher, mut host, _scope) = connect(LIMIT);
    let asking = tokio::spawn(async move {
        let sealed = cipher.encrypt("hello").await;
        let plain = cipher.decrypt("enc:v2:os:x:y.z.w").await;
        (sealed, plain)
    });
    let encrypt = host.next().await;
    assert_eq!(encrypt["method"], REQUEST);
    let params = &encrypt["params"];
    // The wire shape is exact: no extra keys (the Host's schema is strict).
    assert_eq!(params.as_object().unwrap().len(), 3);
    assert!(is_v4_uuid(params["requestId"].as_str().unwrap()));
    assert_eq!(params["operation"], "encrypt");
    assert_eq!(params["value"], "hello");
    let id = params["requestId"].clone();
    host.answer(
        &encrypt,
        json!({"requestId": id, "result": {"ok": true, "value": "enc:v2:os:x:AAA"}}),
    )
    .await;
    let decrypt = host.next().await;
    assert_eq!(decrypt["params"]["operation"], "decrypt");
    assert_eq!(decrypt["params"]["value"], "enc:v2:os:x:y.z.w");
    let id = decrypt["params"]["requestId"].clone();
    host.answer(
        &decrypt,
        json!({"requestId": id, "result": {"ok": true, "value": "plain-back"}}),
    )
    .await;
    let (sealed, plain) = asking.await.unwrap();
    assert_eq!(sealed.unwrap(), "enc:v2:os:x:AAA");
    assert_eq!(plain.unwrap(), "plain-back");
}

#[tokio::test]
async fn a_reply_must_echo_the_request_id_and_match_the_strict_shape() {
    let (cipher, mut host, _scope) = connect(LIMIT);
    let asking = tokio::spawn(async move { cipher.decrypt("enc:v2:os:x:a.b.c").await });
    let request = host.next().await;
    host.answer(
        &request,
        json!({"requestId": "00000000-0000-4000-8000-000000000000", "result": {"ok": true, "value": "x"}}),
    )
    .await;
    assert!(matches!(
        asking.await.unwrap(),
        Err(CipherError::Unavailable { .. })
    ));

    let (cipher, mut host, _scope) = connect(LIMIT);
    let asking = tokio::spawn(async move { cipher.decrypt("enc:v2:os:x:a.b.c").await });
    let request = host.next().await;
    let id = request["params"]["requestId"].clone();
    // A strict reply: an extra key makes the whole reply invalid.
    host.answer(
        &request,
        json!({"requestId": id, "result": {"ok": true, "value": "x", "extra": 1}}),
    )
    .await;
    assert!(matches!(
        asking.await.unwrap(),
        Err(CipherError::Unavailable { .. })
    ));
}

#[tokio::test]
async fn host_error_codes_map_to_decrypt_encrypt_or_unavailable() {
    let cases = [
        ("decrypt", "ZCODE_CREDENTIAL_DECRYPT_FAILED", "decrypt"),
        ("decrypt", "CREDENTIAL_CIPHER_INVALID_PAYLOAD", "decrypt"),
        ("encrypt", "CREDENTIAL_CIPHER_INVALID_PAYLOAD", "encrypt"),
        (
            "decrypt",
            "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE",
            "unavailable",
        ),
        ("encrypt", "SOMETHING_ELSE", "unavailable"),
    ];
    for (operation, code, expected) in cases {
        let (cipher, mut host, _scope) = connect(LIMIT);
        let asking = tokio::spawn(async move {
            match operation {
                "encrypt" => cipher.encrypt("v").await.map(|_| ()),
                _ => cipher.decrypt("enc:v2:os:x:a.b.c").await.map(|_| ()),
            }
        });
        let request = host.next().await;
        let id = request["params"]["requestId"].clone();
        host.answer(
            &request,
            json!({"requestId": id, "result": {"ok": false, "error": {"code": code, "message": "m"}}}),
        )
        .await;
        let error = asking.await.unwrap().unwrap_err();
        let kind = match error {
            CipherError::Decrypt { .. } => "decrypt",
            CipherError::Encrypt { .. } => "encrypt",
            CipherError::Unavailable { .. } => "unavailable",
        };
        assert_eq!(kind, expected, "{code} during {operation}");
    }
}

#[tokio::test]
async fn json_rpc_errors_are_unavailable_and_never_carry_the_host_message() {
    let (cipher, mut host, _scope) = connect(LIMIT);
    let asking = tokio::spawn(async move { cipher.decrypt("enc:v2:os:x:a.b.c").await });
    let request = host.next().await;
    host.fail(&request, -32602, "Credential cipher is unavailable")
        .await;
    let error = asking.await.unwrap().unwrap_err();
    assert!(matches!(error, CipherError::Unavailable { .. }));
    assert!(
        !error
            .to_string()
            .contains("Credential cipher is unavailable")
    );
}

#[tokio::test]
async fn oversize_input_is_refused_before_anything_is_sent() {
    let (cipher, mut host, _scope) = connect(LIMIT);
    let too_big = "a".repeat(1_048_577);
    assert!(matches!(
        cipher.encrypt(&too_big).await,
        Err(CipherError::Encrypt { .. })
    ));
    // No request reached the Host.
    let nothing = tokio::time::timeout(Duration::from_millis(200), host.lines.next_line()).await;
    assert!(
        nothing.is_err(),
        "no line may be sent for an oversize plaintext"
    );
}

#[tokio::test]
async fn an_oversize_reply_is_unavailable() {
    let (cipher, mut host, _scope) = connect(LIMIT);
    let asking = tokio::spawn(async move { cipher.encrypt("v").await });
    let request = host.next().await;
    let id = request["params"]["requestId"].clone();
    let too_big = "a".repeat(1_398_233);
    host.answer(
        &request,
        json!({"requestId": id, "result": {"ok": true, "value": too_big}}),
    )
    .await;
    assert!(matches!(
        asking.await.unwrap(),
        Err(CipherError::Unavailable { .. })
    ));
}

#[tokio::test]
async fn a_request_without_a_reply_times_out_as_unavailable() {
    let (cipher, mut host, _scope) = connect(Duration::from_millis(50));
    let asking = tokio::spawn(async move { cipher.decrypt("enc:v2:os:x:a.b.c").await });
    let _request = host.next().await;
    assert!(matches!(
        asking.await.unwrap(),
        Err(CipherError::Unavailable { .. })
    ));
}

#[tokio::test]
async fn a_closed_connection_is_unavailable() {
    let (cipher, mut host, _scope) = connect(LIMIT);
    let asking = tokio::spawn(async move { cipher.decrypt("enc:v2:os:x:a.b.c").await });
    let _request = host.next().await;
    drop(host);
    assert!(matches!(
        asking.await.unwrap(),
        Err(CipherError::Unavailable { .. })
    ));
}

/// 存储值的上限数的是 UTF-16 码元（zod `.max`，Node `CREDENTIAL_CIPHERTEXT_MAX_CHARS`）：多字节字符的值字节数超过上限、
/// 码元数在上限之内，照常发给 Host；码元数超限的值不发。按字节数判断会把前一种误拒（specs，Bridge wire contract）。
#[tokio::test]
async fn the_stored_value_limit_counts_utf16_units_not_bytes() {
    let (cipher, mut host, _scope) = connect(LIMIT);
    // 500,000 码元，1,500,000 UTF-8 字节。
    let multi_byte = "国".repeat(500_000);
    assert!(
        multi_byte.len() > 1_398_232,
        "the case must exceed the byte limit"
    );
    let asking = tokio::spawn(async move { cipher.decrypt(&multi_byte).await });
    let request = host.next().await;
    assert_eq!(request["params"]["operation"], "decrypt");
    let id = request["params"]["requestId"].clone();
    host.answer(
        &request,
        json!({"requestId": id, "result": {"ok": true, "value": "plain"}}),
    )
    .await;
    assert_eq!(asking.await.unwrap().unwrap(), "plain");

    let (cipher, mut host, _scope) = connect(LIMIT);
    let too_long = "a".repeat(1_398_233);
    assert!(matches!(
        cipher.decrypt(&too_long).await,
        Err(CipherError::Decrypt { .. })
    ));
    let nothing = tokio::time::timeout(Duration::from_millis(200), host.lines.next_line()).await;
    assert!(nothing.is_err(), "an over-limit stored value is not sent");
}
