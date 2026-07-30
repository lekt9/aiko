//! Lifecycle gate around the replaceable peer transport.
//!
//! The setting is checked before the driver receives control. This makes
//! "participation disabled" a structural zero-network guarantee instead of a
//! convention each libp2p behaviour must remember independently.

use crate::PublicationSettings;

pub trait PeerTransport {
    type Error;

    fn start(&mut self) -> Result<(), Self::Error>;
    fn stop(&mut self) -> Result<(), Self::Error>;
    fn is_active(&self) -> bool;
}

#[derive(Debug, thiserror::Error)]
pub enum NetworkGateError<E> {
    #[error("peer transport failed: {0}")]
    Transport(E),
}

pub struct NetworkGate<T> {
    transport: T,
}

impl<T: PeerTransport> NetworkGate<T> {
    pub fn new(transport: T) -> Self {
        Self { transport }
    }

    pub fn apply(
        &mut self,
        settings: &PublicationSettings,
    ) -> Result<(), NetworkGateError<T::Error>> {
        if settings.participation_enabled {
            if !self.transport.is_active() {
                self.transport
                    .start()
                    .map_err(NetworkGateError::Transport)?;
            }
        } else if self.transport.is_active() {
            self.transport.stop().map_err(NetworkGateError::Transport)?;
        }
        Ok(())
    }

    pub fn transport(&self) -> &T {
        &self.transport
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct ProbeTransport {
        active: bool,
        starts: usize,
        stops: usize,
    }

    impl PeerTransport for ProbeTransport {
        type Error = std::convert::Infallible;

        fn start(&mut self) -> Result<(), Self::Error> {
            self.starts += 1;
            self.active = true;
            Ok(())
        }

        fn stop(&mut self) -> Result<(), Self::Error> {
            self.stops += 1;
            self.active = false;
            Ok(())
        }

        fn is_active(&self) -> bool {
            self.active
        }
    }

    #[test]
    fn default_settings_never_start_transport() {
        let mut gate = NetworkGate::new(ProbeTransport::default());
        gate.apply(&PublicationSettings::default()).unwrap();
        assert_eq!(gate.transport().starts, 0);
        assert_eq!(gate.transport().stops, 0);
    }

    #[test]
    fn participation_controls_transport_idempotently() {
        let mut gate = NetworkGate::new(ProbeTransport::default());
        let mut settings = PublicationSettings {
            participation_enabled: true,
            ..PublicationSettings::default()
        };
        gate.apply(&settings).unwrap();
        gate.apply(&settings).unwrap();
        assert_eq!(gate.transport().starts, 1);
        settings.participation_enabled = false;
        gate.apply(&settings).unwrap();
        assert_eq!(gate.transport().stops, 1);
    }
}
