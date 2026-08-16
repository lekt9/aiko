//! Critical built-ins are not generic observer hooks.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookClass {
    ContractDeclarationProjection,
    Authority,
    Effect,
    Observational,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailurePolicy {
    FailClosedNoLaunch,
    FailOpen,
}

impl HookClass {
    pub const fn failure_policy(self) -> FailurePolicy {
        match self {
            Self::Observational => FailurePolicy::FailOpen,
            Self::ContractDeclarationProjection | Self::Authority | Self::Effect => {
                FailurePolicy::FailClosedNoLaunch
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_generic_observer_is_fail_open() {
        assert_eq!(
            HookClass::Observational.failure_policy(),
            FailurePolicy::FailOpen
        );
        for hook in [
            HookClass::ContractDeclarationProjection,
            HookClass::Authority,
            HookClass::Effect,
        ] {
            assert_eq!(hook.failure_policy(), FailurePolicy::FailClosedNoLaunch);
        }
    }
}
