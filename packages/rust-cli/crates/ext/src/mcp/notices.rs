//! 读者交给连接任务的通知（docs/specs/rust-cli/ext.md §3.3“通道与溢出”）。
//!
//! 缺陷修复（审查 R1-18）：原来是无界通道，服务器连续发 `list_changed` 而连接任务正在拉清单时，通知无限堆积。
//! 这里没有队列，状态本身有界：
//! - `list_changed` 按种类合并：同一种还没取走时不再加一条（收到后连接任务重新拉整份清单，可重建）；
//! - 关闭只有一次，一定送达（排在还没取走的 `list_changed` 之后）。
//!
//! Fork (F7 PR 4): 资源通知（`resources/updated` 按 uri、`resources/list_changed`）有自己的等待队列，先于
//! `list_changed` 送出，所以一连串的工具清单变化不会饿死它们。队列按条数和 uri 字节数有界（见
//! [`RESOURCE_NOTICE_CAP`] 与 [`RESOURCE_URI_BYTE_CAP`]）。
//!
//! 发送方从不等待：读者是这条连接上事件的唯一消费者，连接任务拉清单时正等着读者送来响应，读者若在这里等连接
//! 任务就成了互相等待。

use rust_cli_base::sync::LockUnpoisoned;
use std::collections::{HashSet, VecDeque};
use std::sync::{Arc, Mutex};

use tokio::sync::watch;

use super::rpc::Notice;

/// Fork (F7 PR 4): the most distinct resource updates that wait at once. Past it, an update of a uri that does not wait
/// yet is dropped: the page is not told of that uri until the server sends it again. The overflow keeps the first
/// `RESOURCE_NOTICE_CAP` uris in arrival order. A resource list change is admitted past the cap: it waits as one entry
/// whatever the count, and it is never lost to an update's overflow.
const RESOURCE_NOTICE_CAP: usize = 1024;

/// Fork (F7 PR 4): the bytes of the uris that wait at once, past which an update is dropped by the same rule as
/// [`RESOURCE_NOTICE_CAP`]. The server chooses the uris, so their size is bounded too.
const RESOURCE_URI_BYTE_CAP: usize = 1024 * 1024;

/// The list kinds the connection task refreshes (review, round 4): any other kind a server names is dropped, since the
/// manager has no work for it.
const QUEUED_LIST_KINDS: [&str; 2] = ["tools", "prompts"];

/// One waiting resource notice. A uri is stored once: the queue and the set share one allocation.
enum Waiting {
    Updated(Arc<str>),
    ListChanged,
}

#[derive(Default)]
struct Pending {
    /// 还没取走的 `list_changed` 种类，按第一次到达的顺序（只有 [`QUEUED_LIST_KINDS`]）。
    changed: VecDeque<String>,
    /// Fork (F7 PR 4): the resource notices that wait, in the order they first arrived.
    resources: VecDeque<Waiting>,
    /// The uris of `resources`, for the merge of a repeat.
    waiting_uris: HashSet<Arc<str>>,
    /// A resource list change waits (one entry, whatever the count).
    list_waits: bool,
    /// The bytes of the uris of `resources`.
    uri_bytes: usize,
    closed: Option<Notice>,
}

/// Fork (F7 PR 4): admits a resource notice unless it waits already, or it is an update that does not fit the caps (it is
/// then dropped, and logged at debug, so the overflow is visible).
fn admit(pending: &mut Pending, notice: Notice) {
    match notice {
        Notice::ResourceUpdated(uri) => {
            if pending.waiting_uris.contains(uri.as_str()) {
                return;
            }
            let fits = pending.resources.len() < RESOURCE_NOTICE_CAP
                && pending.uri_bytes + uri.len() <= RESOURCE_URI_BYTE_CAP;
            if !fits {
                tracing::debug!(%uri, "MCP resource update dropped: the waiting queue is full");
                return;
            }
            pending.uri_bytes += uri.len();
            let uri: Arc<str> = Arc::from(uri);
            pending.waiting_uris.insert(uri.clone());
            pending.resources.push_back(Waiting::Updated(uri));
        }
        // One entry whatever the count: a list change is admitted past the cap.
        Notice::ResourceListChanged if !pending.list_waits => {
            pending.list_waits = true;
            pending.resources.push_back(Waiting::ListChanged);
        }
        _ => {}
    }
}

/// 读者一侧。释放时接收方读完剩下的就结束。
pub(crate) struct NoticeSender {
    pending: Arc<Mutex<Pending>>,
    wake: watch::Sender<()>,
}

/// 连接任务一侧。
pub(crate) struct NoticeReceiver {
    pending: Arc<Mutex<Pending>>,
    wake: watch::Receiver<()>,
}

pub(crate) fn channel() -> (NoticeSender, NoticeReceiver) {
    let pending = Arc::new(Mutex::default());
    let (wake, woken) = watch::channel(());
    (
        NoticeSender {
            pending: pending.clone(),
            wake,
        },
        NoticeReceiver {
            pending,
            wake: woken,
        },
    )
}

impl NoticeSender {
    pub(crate) fn send(&self, notice: Notice) {
        {
            let mut pending = self.pending.lock_unpoisoned();
            match notice {
                Notice::ListChanged(kind) => {
                    if QUEUED_LIST_KINDS.contains(&kind.as_str())
                        && !pending.changed.contains(&kind)
                    {
                        pending.changed.push_back(kind);
                    }
                }
                closed @ Notice::Closed { .. } => pending.closed = Some(closed),
                resource @ (Notice::ResourceUpdated(_) | Notice::ResourceListChanged) => {
                    admit(&mut pending, resource);
                }
            }
        }
        self.wake.send_replace(());
    }
}

impl NoticeReceiver {
    /// Resource notices first (so a busy list cannot starve them), then the list changes, then the close.
    fn take(&self) -> Option<Notice> {
        let mut pending = self.pending.lock_unpoisoned();
        if let Some(waiting) = pending.resources.pop_front() {
            return Some(match waiting {
                Waiting::Updated(uri) => {
                    pending.waiting_uris.remove(&*uri);
                    pending.uri_bytes -= uri.len();
                    Notice::ResourceUpdated(uri.to_string())
                }
                Waiting::ListChanged => {
                    pending.list_waits = false;
                    Notice::ResourceListChanged
                }
            });
        }
        if let Some(kind) = pending.changed.pop_front() {
            return Some(Notice::ListChanged(kind));
        }
        pending.closed.take()
    }

    /// 下一条通知；发送方已释放且没有剩下的通知时为 None。
    pub(crate) async fn recv(&mut self) -> Option<Notice> {
        loop {
            self.wake.borrow_and_update();
            if let Some(notice) = self.take() {
                return Some(notice);
            }
            if self.wake.changed().await.is_err() {
                return self.take();
            }
        }
    }
}

#[cfg(test)]
#[path = "notices_tests.rs"]
mod tests;
