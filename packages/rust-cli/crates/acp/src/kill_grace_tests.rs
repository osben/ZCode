//! Node `killGraceMs` (`DEFAULT_TIMEOUTS` / `runAcpProcessTeardown`): the ACP agent gets 5 s between TERM and KILL.

use std::time::Duration;

use crate::runtime::AcpTimeouts;

#[test]
fn the_acp_kill_grace_is_nodes_five_seconds() {
    assert_eq!(AcpTimeouts::default().kill_grace, Duration::from_secs(5));
}
