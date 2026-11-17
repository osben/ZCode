//! Fork: starting a helper process (specs/fork-rust-node-helper.md F1, "Helper command" and the lifecycle). The
//! process comes from the injected launcher; the start makes it the running slot of its generation.

use super::link::{Relay, WriterRelease};
use super::*;

/// A launched helper process. Dropping `guard` kills the process tree.
pub struct NodeHelperProcess {
    pub stdin: Box<dyn AsyncWrite + Send + Unpin>,
    pub stdout: Box<dyn AsyncBufRead + Send + Unpin>,
    pub guard: Box<dyn Send>,
}

/// Starts one helper process. The implementation owns the child's stderr.
#[async_trait]
pub trait NodeHelperLauncher: Send + Sync {
    async fn launch(&self) -> io::Result<NodeHelperProcess>;
}

impl NodeHelper {
    /// Launches and initializes a helper, then makes it the running slot. Runs once per start, shared by the callers
    /// that were waiting for it. Holds no lock across an await.
    pub(super) async fn start(&self, generation: u64) -> Result<(), RpcError> {
        let process = match self.launcher.launch().await {
            Ok(process) => process,
            Err(error) => {
                self.warn_once("launch", Some(error.to_string()));
                self.start_failed(generation);
                return Err(unavailable("the helper could not be started"));
            }
        };
        let NodeHelperProcess {
            stdin,
            stdout,
            guard,
        } = process;
        let (peer, writer) = connection::start(stdin, &self.spawner, Options::default());
        let guard: Box<dyn Send> = Box::new(WriterRelease {
            writer,
            _process: guard,
        });
        let relay = Arc::new(Relay {
            host: self.host.clone(),
            helper: self.myself.clone(),
            generation,
        });
        let weak = self.myself.clone();
        let reader_peer = peer.clone();
        let reader_spawner = self.spawner.clone();
        drop(self.spawner.spawn("node-helper-reader", async move {
            let _ = connection::serve(
                stdout,
                reader_peer,
                relay,
                reader_spawner,
                Options::default(),
            )
            .await;
            if let Some(helper) = weak.upgrade() {
                // The slot goes first, so a request that begins after it starts cancelled (requests::begin).
                helper.link_lost(generation);
                helper.requests_lost(generation);
            }
        }));

        let initialized = tokio::time::timeout(
            self.timing.initialize,
            peer.request(
                "helper/initialize",
                &json!({"protocolVersion": PROTOCOL_VERSION}),
            ),
        )
        .await;
        let answer = match initialized {
            Ok(Ok(answer)) => answer,
            Ok(Err(_)) | Err(_) => {
                drop(guard);
                self.warn_once("initialize", None);
                self.start_failed(generation);
                return Err(unavailable("the helper did not initialize"));
            }
        };
        if answer["protocolVersion"].as_u64() != Some(PROTOCOL_VERSION) {
            drop(guard);
            self.state.lock_unpoisoned().slot = Slot::Down;
            tracing::warn!(
                event = "helper.unavailable",
                reason = "protocol_version",
                "the helper speaks another protocol version; it stays down"
            );
            return Err(unavailable("the helper speaks another protocol version"));
        }
        let methods: HashSet<String> = answer["methods"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        if methods.is_empty() {
            // A helper that advertises nothing is broken (the bundle and this binary disagree): report it as
            // unavailable instead of answering every method -32601 as if no helper were configured.
            drop(guard);
            self.warn_once(
                "initialize",
                Some("the helper advertised no methods".to_owned()),
            );
            self.start_failed(generation);
            return Err(unavailable("the helper advertised no methods"));
        }
        let now = Instant::now();
        let mut state = self.state.lock_unpoisoned();
        state.slot = Slot::Running(Box::new(Running {
            generation,
            peer,
            methods,
            in_flight: 0,
            last_used: now,
            heard: 0,
            pipes: HashMap::new(),
            sessions: HashMap::new(),
            children: HashSet::new(),
            panels: Box::new(panels::Panels::new(
                self.myself.clone(),
                self.spawner.clone(),
            )),
            _guard: guard,
        }));
        state.retry_at = None;
        drop(state);
        self.warned.store(false, Ordering::Relaxed);
        tracing::info!(
            event = "helper.spawned",
            generation,
            "the node helper started"
        );
        self.spawn_reclaim(generation);
        Ok(())
    }

    /// Returns a failed start to idle; the next call starts again once the cooldown has passed. Only the start of
    /// `generation` does this.
    pub(super) fn start_failed(&self, generation: u64) {
        let mut state = self.state.lock_unpoisoned();
        if matches!(&state.slot, Slot::Starting(_)) && state.generation == generation {
            state.slot = Slot::Idle;
            state.retry_at = Some(Instant::now() + self.timing.start_cooldown);
        }
    }
}
