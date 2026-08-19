"""Ecosystem adapter registry.

Adding a new language: implement :class:`~devtwin.adapters.base.EcosystemAdapter`
in a new module and add an instance to ``ADAPTERS`` below. See
``docs/adapters.md`` for a full walkthrough and template.
"""

from __future__ import annotations

from devtwin.adapters.base import EcosystemAdapter
from devtwin.adapters.dotnet import DotnetAdapter
from devtwin.adapters.generic import GenericAdapter
from devtwin.adapters.go import GoAdapter
from devtwin.adapters.jvm import JvmAdapter
from devtwin.adapters.node import NodeAdapter
from devtwin.adapters.python import PythonAdapter
from devtwin.adapters.php import PhpAdapter
from devtwin.adapters.ruby import RubyAdapter
from devtwin.adapters.rust import RustAdapter
from devtwin.adapters.swift import SwiftAdapter

# Order matters only for tie-breaking display; detection confidence drives
# which ecosystem is "primary".
ADAPTERS: list[EcosystemAdapter] = [
    PythonAdapter(),
    NodeAdapter(),
    JvmAdapter(),
    GoAdapter(),
    RustAdapter(),
    DotnetAdapter(),
    SwiftAdapter(),
    RubyAdapter(),
    PhpAdapter(),
]

GENERIC_ADAPTER = GenericAdapter()

__all__ = ["ADAPTERS", "GENERIC_ADAPTER", "EcosystemAdapter"]
