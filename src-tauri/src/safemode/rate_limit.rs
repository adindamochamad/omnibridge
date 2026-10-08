use crate::safemode::policy::RateLimit;
use std::collections::HashMap;

#[derive(Debug, Default)]
pub struct RateLimiter {
    events: HashMap<String, Vec<u64>>,
}

impl RateLimiter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns `true` if the call is within the limit and should proceed.
    pub fn allow(&mut self, key: &str, limit: &RateLimit, now_ms: u64) -> bool {
        let window_ms = limit.per_secs * 1000;
        let entries = self.events.entry(key.to_string()).or_default();
        entries.retain(|t| now_ms.saturating_sub(*t) < window_ms);
        if entries.len() >= limit.max as usize {
            return false;
        }
        entries.push(now_ms);
        true
    }

    pub fn reset(&mut self) {
        self.events.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn n_plus_one_within_window_denied() {
        let mut limiter = RateLimiter::new();
        let limit = RateLimit {
            max: 2,
            per_secs: 60,
        };
        assert!(limiter.allow("send_bytes", &limit, 1_000));
        assert!(limiter.allow("send_bytes", &limit, 2_000));
        assert!(!limiter.allow("send_bytes", &limit, 3_000));
    }

    #[test]
    fn allowed_again_after_window() {
        let mut limiter = RateLimiter::new();
        let limit = RateLimit {
            max: 2,
            per_secs: 60,
        };
        assert!(limiter.allow("send_bytes", &limit, 0));
        assert!(limiter.allow("send_bytes", &limit, 10_000));
        assert!(!limiter.allow("send_bytes", &limit, 20_000));
        assert!(limiter.allow("send_bytes", &limit, 61_000));
    }
}
