"""Credential envelope: opaque capabilities backed only by an OS credential vault."""
from .vault import CredentialEnvelope, OSCredentialVault, SyntheticVault, VaultRefusal

__all__ = ["CredentialEnvelope", "OSCredentialVault", "SyntheticVault", "VaultRefusal"]
