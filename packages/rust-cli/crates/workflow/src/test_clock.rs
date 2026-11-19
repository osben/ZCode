//! A clock the test moves by hand (W6b part 5): the stall clock and the quota timer read time from it, and a job runs
//! when the test advances past its delay. Jobs run outside every lock, so a job may schedule another.

use crate::model_failure::RedriveClock;
use std::sync::{Arc, Mutex};

type Job = Box<dyn FnOnce() + Send>;

pub(crate) struct AdvancingClock {
    now: Mutex<u64>,
    seq: Mutex<u64>,
    /// Scheduled jobs: due time, scheduling order, job.
    jobs: Mutex<Vec<(u64, u64, Job)>>,
    /// Every delay asked for, in order (refused ones included).
    delays: Mutex<Vec<u64>>,
    accept: Mutex<bool>,
}

impl AdvancingClock {
    pub(crate) fn new(start: u64) -> Arc<Self> {
        Arc::new(Self {
            now: Mutex::new(start),
            seq: Mutex::new(0),
            jobs: Mutex::new(Vec::new()),
            delays: Mutex::new(Vec::new()),
            accept: Mutex::new(true),
        })
    }

    /// Whether the next jobs are accepted. A refusing clock returns false, as a failed thread spawn does.
    pub(crate) fn set_accepting(&self, accept: bool) {
        *self.accept.lock().expect("accept") = accept;
    }

    pub(crate) fn pending(&self) -> usize {
        self.jobs.lock().expect("jobs").len()
    }

    pub(crate) fn delays(&self) -> Vec<u64> {
        self.delays.lock().expect("delays").clone()
    }

    pub(crate) fn advance(&self, by_ms: u64) {
        let at = self.now_ms() + by_ms;
        self.advance_to(at);
    }

    /// Runs, in due order, every job due at or before `at`, then leaves the clock at `at`.
    pub(crate) fn advance_to(&self, at: u64) {
        loop {
            let next = {
                let mut jobs = self.jobs.lock().expect("jobs");
                let earliest = jobs
                    .iter()
                    .enumerate()
                    .filter(|(_, (due, _, _))| *due <= at)
                    .min_by_key(|(_, (due, seq, _))| (*due, *seq))
                    .map(|(index, _)| index);
                earliest.map(|index| jobs.remove(index))
            };
            let Some((due, _, job)) = next else { break };
            {
                let mut now = self.now.lock().expect("now");
                if *now < due {
                    *now = due;
                }
            }
            job();
        }
        let mut now = self.now.lock().expect("now");
        if *now < at {
            *now = at;
        }
    }
}

impl RedriveClock for AdvancingClock {
    fn after(&self, delay_ms: u64, job: Box<dyn FnOnce() + Send>) -> bool {
        self.delays.lock().expect("delays").push(delay_ms);
        if !*self.accept.lock().expect("accept") {
            return false;
        }
        let due = self.now_ms() + delay_ms;
        let mut seq = self.seq.lock().expect("seq");
        *seq += 1;
        self.jobs.lock().expect("jobs").push((due, *seq, job));
        true
    }

    fn random(&self) -> f64 {
        0.5
    }

    fn now_ms(&self) -> u64 {
        *self.now.lock().expect("now")
    }
}
